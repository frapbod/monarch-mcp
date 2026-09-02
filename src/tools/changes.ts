import { isDeepStrictEqual } from 'node:util';

import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Account } from '@hakimelek/monarchmoney';

import { budgetAmount } from '../budget-state.js';
import type { AccountValues, ChangeGuard, ChangeStore, UndoStep } from '../changes.js';
import { mapConcurrent } from '../concurrency.js';
import { ruleInputFromApi } from '../rule-state.js';
import type { MonarchAccess, MonarchClient } from '../session.js';
import {
  READ_ONLY,
  UPDATE,
  addTool,
  reportProgress,
  requestCancelled,
  throwIfCancelled,
} from '../tool.js';
import {
  recurringMatches,
  transactionSplitValues,
  transactionTagIds,
  transactionValues,
} from '../transaction-state.js';

async function undo(client: MonarchClient, step: UndoStep): Promise<void> {
  switch (step.operation) {
    case 'update_transaction':
      await client.updateTransaction(step.id, step.values);
      return;
    case 'set_transaction_tags':
      await client.setTransactionTags(step.id, step.tagIds);
      return;
    case 'set_transaction_splits':
      await client.updateTransactionSplits(step.id, step.splits);
      return;
    case 'restore_transaction':
      await client.updateTransaction(step.id, step.values);
      await client.setTransactionTags(step.id, step.tagIds);
      await client.updateTransactionSplits(step.id, step.splits);
      return;
    case 'delete_transaction_rule':
      await client.deleteTransactionRule(step.id);
      return;
    case 'update_transaction_rule':
      await client.updateTransactionRule(step.id, step.values);
      return;
    case 'create_transaction_rule':
      await client.createTransactionRule(step.values);
      return;
    case 'update_recurring_merchant':
      await client.updateRecurringMerchant(step.values);
      return;
    case 'delete_account':
      await client.deleteAccount(step.id);
      return;
    case 'update_account':
      await client.updateAccount(step.id, step.values);
      return;
    case 'delete_transaction':
      await client.deleteTransaction(step.id);
      return;
    case 'delete_transaction_tag':
      await client.deleteTransactionTag(step.id);
      return;
    case 'delete_transaction_category':
      await client.deleteTransactionCategory(step.id);
      return;
    case 'set_budget_amount':
      await client.setBudgetAmount(step.values);
  }
}

function independentTransactionUndo(step: UndoStep): boolean {
  return step.operation === 'update_transaction' || step.operation === 'restore_transaction';
}

async function undoAll(
  client: MonarchClient,
  steps: UndoStep[],
  context: ServerContext,
): Promise<void> {
  const pending = [...steps].reverse();
  let completed = 0;
  while (pending.length) {
    throwIfCancelled(context, `Undo cancelled after ${completed} of ${steps.length} steps`);
    const next = pending.shift();
    if (!next) break;
    if (!independentTransactionUndo(next)) {
      await undo(client, next);
      completed += 1;
      await reportProgress(
        context,
        completed,
        steps.length,
        `Restored ${completed} of ${steps.length}`,
      );
      continue;
    }
    const batch: UndoStep[] = [next];
    while (pending[0] && independentTransactionUndo(pending[0])) {
      const candidate = pending.shift();
      if (candidate) batch.push(candidate);
    }
    await mapConcurrent(batch, 4, async (step) => {
      throwIfCancelled(context, `Undo cancelled after ${completed} of ${steps.length} steps`);
      await undo(client, step);
      completed += 1;
      await reportProgress(
        context,
        completed,
        steps.length,
        `Restored ${completed} of ${steps.length}`,
      );
    });
  }
}

function selectedValuesMatch<Values extends object>(
  actual: Values,
  expected: Partial<Values>,
): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key as keyof Values] === value);
}

function accountValues(account: Account): AccountValues {
  return {
    accountName: account.displayName,
    accountBalance: account.displayBalance,
    accountType: account.type.name,
    accountSubType: account.subtype.name,
    includeInNetWorth: account.includeInNetWorth,
    hideFromSummaryList: account.hideFromList,
    hideTransactionsFromReports: account.hideTransactionsFromReports,
  };
}

function withoutGraphqlMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGraphqlMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '__typename')
      .map(([key, child]) => [key, withoutGraphqlMetadata(child)]),
  );
}

async function guardConflict(
  client: MonarchClient,
  guard: ChangeGuard,
): Promise<string | undefined> {
  try {
    switch (guard.kind) {
      case 'transaction': {
        const details = await client.getTransactionDetails(guard.id);
        if (guard.values && !selectedValuesMatch(transactionValues(details), guard.values)) {
          return `transaction:${guard.id}`;
        }
        if (
          guard.tagIds &&
          !isDeepStrictEqual([...transactionTagIds(details)].sort(), [...guard.tagIds].sort())
        ) {
          return `transaction:${guard.id}`;
        }
        if (guard.splits && !isDeepStrictEqual(transactionSplitValues(details), guard.splits)) {
          return `transaction:${guard.id}`;
        }
        return;
      }
      case 'account': {
        const account = (await client.getAccounts()).accounts.find(({ id }) => id === guard.id);
        return account && selectedValuesMatch(accountValues(account), guard.values)
          ? undefined
          : `account:${guard.id}`;
      }
      case 'recurring': {
        const details = await client.getTransactionDetails(guard.transactionId);
        return recurringMatches(details, guard.values)
          ? undefined
          : `recurring:${guard.transactionId}`;
      }
      case 'rule': {
        const rule = (await client.getTransactionRules()).transactionRules.find(
          ({ id }) => id === guard.id,
        );
        const definitionMatches =
          rule &&
          isDeepStrictEqual(
            withoutGraphqlMetadata(ruleInputFromApi(rule)),
            withoutGraphqlMetadata(guard.value),
          );
        const applicationCountMatches =
          guard.recentApplicationCount === undefined ||
          rule?.recentApplicationCount === guard.recentApplicationCount;
        const lastAppliedAtMatches =
          guard.lastAppliedAt === undefined || rule?.lastAppliedAt === guard.lastAppliedAt;
        return definitionMatches && applicationCountMatches && lastAppliedAtMatches
          ? undefined
          : `rule:${guard.id}`;
      }
      case 'tag': {
        const tag = (await client.getTransactionTags()).tags.find(({ id }) => id === guard.id);
        const used = await client.getAllTransactions({ tagIds: [guard.id], pageSize: 1 });
        return tag && tag.name === guard.name && tag.color === guard.color && used.length === 0
          ? undefined
          : `tag:${guard.id}`;
      }
      case 'category': {
        const category = (await client.getTransactionCategories()).categories.find(
          ({ id }) => id === guard.id,
        );
        const used = await client.getAllTransactions({ categoryIds: [guard.id], pageSize: 1 });
        return category &&
          category.name === guard.name &&
          category.group.id === guard.groupId &&
          used.length === 0
          ? undefined
          : `category:${guard.id}`;
      }
      case 'budget': {
        const { categoryId, categoryGroupId, startDate, amount } = guard.values;
        const month = startDate ?? new Date().toISOString().slice(0, 7).concat('-01');
        const data = await client.getBudgets(month, month);
        const actual = budgetAmount(
          data.budgetData,
          categoryId ? 'category' : 'category_group',
          categoryId ?? categoryGroupId ?? '',
          month,
        );
        return actual === amount
          ? undefined
          : `budget:${categoryId ?? categoryGroupId ?? 'unknown'}:${month}`;
      }
    }
  } catch {
    return `${guard.kind}:${
      'id' in guard
        ? guard.id
        : 'transactionId' in guard
          ? guard.transactionId
          : (guard.values.categoryId ?? guard.values.categoryGroupId ?? 'unknown')
    }`;
  }
}

async function conflictingGuards(client: MonarchClient, guards: ChangeGuard[]): Promise<string[]> {
  const conflicts = await mapConcurrent(guards, 8, (guard) => guardConflict(client, guard));
  return conflicts.filter((value): value is string => value !== undefined);
}

export function registerChangeTools(
  server: McpServer,
  session: MonarchAccess,
  changes: ChangeStore,
): void {
  addTool(
    server,
    {
      name: 'get_change_history',
      title: 'Get change history',
      description:
        'Inspect agent-made Monarch changes and their undo status. Supply change_id to include the saved inverse operations.',
      inputSchema: z.object({
        change_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      hints: READ_ONLY,
    },
    async ({ change_id, limit }) => {
      if (change_id) {
        const change = changes.get(change_id);
        if (!change) throw new Error(`Change ${change_id} was not found`);
        return { data: { change }, summary: `Retrieved change ${change_id}.` };
      }
      const history = changes
        .list(limit)
        .map(({ undo: _undo, guards: _guards, snapshot: _snapshot, ...change }) => change);
      return {
        data: { changes: history },
        summary: `Retrieved ${history.length} recorded Monarch changes.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'undo_change',
      title: 'Undo change',
      description:
        'Revert one recorded Monarch change by change ID. Already-undone changes return successfully without applying twice.',
      inputSchema: z.object({
        change_id: z.string().min(1),
        force: z
          .boolean()
          .default(false)
          .describe('Ignore newer-state conflicts and restore the saved state anyway'),
      }),
      hints: UPDATE,
    },
    async ({ change_id, force }, context) => {
      throwIfCancelled(context);
      const change = changes.get(change_id);
      if (!change) throw new Error(`Change ${change_id} was not found`);
      if (
        (change.status === 'prepared' ||
          change.status === 'undoing' ||
          change.status === 'uncertain') &&
        !force
      ) {
        throw new Error(
          `Change ${change_id} has an uncertain upstream outcome; inspect it and retry with force=true only if restoring its saved prior state is intended`,
        );
      }
      if (!change.reversible)
        throw new Error(`Change ${change_id} is not automatically reversible`);
      if (change.status === 'undone') {
        return {
          data: { change_id, status: 'undone', affected_count: change.affected_count },
          summary: `Change ${change_id} was already undone.`,
        };
      }
      try {
        await session.write(async (client) => {
          throwIfCancelled(context);
          if (!force && change.guards?.length) {
            const conflicts = await conflictingGuards(client, change.guards);
            throwIfCancelled(context);
            if (conflicts.length) {
              throw new Error(
                `Change ${change_id} conflicts with newer Monarch state for ${conflicts.join(', ')}; inspect it or retry with force=true`,
              );
            }
          }
          changes.markUndoing(change_id);
          await undoAll(client, change.undo, context);
        });
        changes.markUndone(change_id);
      } catch (error) {
        if (changes.get(change_id)?.status === 'undoing') {
          try {
            changes.markUncertain(change_id);
          } catch {
            // The undoing record still captures the interrupted attempt.
          }
        }
        throw error;
      }
      return {
        data: { change_id, status: 'undone', affected_count: change.affected_count },
        summary: `Undid change ${change_id} across ${change.affected_count} records.`,
        cancelled: requestCancelled(context),
        change: {
          id: change_id,
          affectedCount: change.affected_count,
          reversible: change.reversible,
        },
      };
    },
  );
}
