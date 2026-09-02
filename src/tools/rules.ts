import type {
  RuleAmountCriterion,
  RuleCriterion,
  Transaction,
  TransactionRuleInput,
} from '@hakimelek/monarchmoney';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  activatePrepared,
  type ChangeGuard,
  type ChangeStore,
  type UndoStep,
  performPrepared,
} from '../changes.js';
import { mapConcurrent } from '../concurrency.js';
import { compactTransaction } from '../projections.js';
import { ruleDefinition, ruleInputFromApi, ruleRestoreInput } from '../rule-state.js';
import type { MonarchAccess, MonarchClient } from '../session.js';
import { transactionGuard, transactionUndoStep } from '../transaction-state.js';
import { CREATE, READ_ONLY, REMOVE, UPDATE, addTool, invalidInput } from '../tool.js';

const criterionSchema = z.object({
  operator: z.enum(['contains', 'eq']),
  value: z.string().min(1),
});

const ruleShape = {
  merchant_criteria_use_original_statement: z.boolean().optional(),
  merchant_criteria: z.array(criterionSchema).optional(),
  original_statement_criteria: z.array(criterionSchema).optional(),
  merchant_name_criteria: z.array(criterionSchema).optional(),
  amount_criteria: z
    .object({
      operator: z.enum(['gt', 'lt', 'eq', 'between']),
      is_expense: z.boolean().optional(),
      value: z.number().optional(),
      lower: z.number().optional(),
      upper: z.number().optional(),
    })
    .optional(),
  category_ids: z.array(z.string().min(1)).optional(),
  account_ids: z.array(z.string().min(1)).optional(),
  set_merchant_action: z.string().min(1).optional(),
  set_category_action: z.string().min(1).optional(),
  add_tags_action: z.array(z.string().min(1)).optional(),
  link_goal_action: z.string().min(1).optional(),
  review_status_action: z.string().min(1).optional(),
  set_hide_from_reports_action: z.boolean().optional(),
  split_transactions_action: z
    .object({
      amount_type: z.enum(['ABSOLUTE', 'PERCENTAGE']),
      splits: z
        .array(
          z.object({
            category_id: z.string().min(1).optional(),
            merchant_name: z.string().min(1).optional(),
            amount: z.number().optional(),
            goal_id: z.string().min(1).optional(),
            tag_ids: z.array(z.string().min(1)).optional(),
            hidden_from_reports: z.boolean().optional(),
            review_status: z.string().min(1).optional(),
          }),
        )
        .min(2),
    })
    .optional(),
  apply_to_existing_transactions: z.boolean().optional(),
};

type RuleArguments = z.output<z.ZodObject<typeof ruleShape>>;

const criteriaKeys = [
  'merchant_criteria',
  'original_statement_criteria',
  'merchant_name_criteria',
  'amount_criteria',
  'category_ids',
  'account_ids',
] as const;

const actionKeys = [
  'set_merchant_action',
  'set_category_action',
  'add_tags_action',
  'link_goal_action',
  'review_status_action',
  'set_hide_from_reports_action',
  'split_transactions_action',
] as const;

function ruleInput(args: RuleArguments): TransactionRuleInput {
  const amount = args.amount_criteria;
  return {
    ...(args.merchant_criteria_use_original_statement !== undefined
      ? { merchantCriteriaUseOriginalStatement: args.merchant_criteria_use_original_statement }
      : {}),
    ...(args.merchant_criteria ? { merchantCriteria: args.merchant_criteria } : {}),
    ...(args.original_statement_criteria
      ? { originalStatementCriteria: args.original_statement_criteria }
      : {}),
    ...(args.merchant_name_criteria ? { merchantNameCriteria: args.merchant_name_criteria } : {}),
    ...(amount
      ? {
          amountCriteria: {
            operator: amount.operator,
            ...(amount.is_expense !== undefined ? { isExpense: amount.is_expense } : {}),
            ...(amount.value !== undefined ? { value: amount.value } : {}),
            ...(amount.lower !== undefined || amount.upper !== undefined
              ? {
                  valueRange: {
                    ...(amount.lower !== undefined ? { lower: amount.lower } : {}),
                    ...(amount.upper !== undefined ? { upper: amount.upper } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(args.category_ids ? { categoryIds: args.category_ids } : {}),
    ...(args.account_ids ? { accountIds: args.account_ids } : {}),
    ...(args.set_merchant_action ? { setMerchantAction: args.set_merchant_action } : {}),
    ...(args.set_category_action ? { setCategoryAction: args.set_category_action } : {}),
    ...(args.add_tags_action ? { addTagsAction: args.add_tags_action } : {}),
    ...(args.link_goal_action ? { linkGoalAction: args.link_goal_action } : {}),
    ...(args.review_status_action ? { reviewStatusAction: args.review_status_action } : {}),
    ...(args.set_hide_from_reports_action !== undefined
      ? { setHideFromReportsAction: args.set_hide_from_reports_action }
      : {}),
    ...(args.split_transactions_action
      ? {
          splitTransactionsAction: {
            amountType: args.split_transactions_action.amount_type,
            splitsInfo: args.split_transactions_action.splits.map((split) => ({
              ...(split.category_id ? { categoryId: split.category_id } : {}),
              ...(split.merchant_name ? { merchantName: split.merchant_name } : {}),
              ...(split.amount !== undefined ? { amount: split.amount } : {}),
              ...(split.goal_id ? { goalId: split.goal_id } : {}),
              ...(split.tag_ids ? { tags: split.tag_ids } : {}),
              ...(split.hidden_from_reports !== undefined
                ? { hideFromReports: split.hidden_from_reports }
                : {}),
              ...(split.review_status ? { reviewStatus: split.review_status } : {}),
            })),
          },
        }
      : {}),
    ...(args.apply_to_existing_transactions !== undefined
      ? { applyToExistingTransactions: args.apply_to_existing_transactions }
      : {}),
  };
}

function matchesText(
  criteria: RuleCriterion[] | undefined,
  text: string | null | undefined,
): boolean {
  if (!criteria?.length) return true;
  const value = (text ?? '').toLocaleLowerCase();
  return criteria.some((criterion) => {
    const expected = criterion.value.toLocaleLowerCase();
    return criterion.operator === 'eq' ? value === expected : value.includes(expected);
  });
}

function matchesAmount(criteria: RuleAmountCriterion | undefined, amount: number): boolean {
  if (!criteria) return true;
  if (criteria.isExpense === true && amount >= 0) return false;
  if (criteria.isExpense === false && amount <= 0) return false;
  const value = criteria.isExpense === undefined ? amount : Math.abs(amount);
  if (criteria.operator === 'between') {
    return (
      (criteria.valueRange?.lower === undefined || value >= criteria.valueRange.lower) &&
      (criteria.valueRange?.upper === undefined || value <= criteria.valueRange.upper)
    );
  }
  if (criteria.value === undefined) return false;
  if (criteria.operator === 'gt') return value > criteria.value;
  if (criteria.operator === 'lt') return value < criteria.value;
  return value === criteria.value;
}

function matchesRule(transaction: Transaction, rule: TransactionRuleInput): boolean {
  const original = transaction.plaidName;
  const merchant = transaction.merchant?.name;
  return (
    matchesText(
      rule.merchantCriteria,
      rule.merchantCriteriaUseOriginalStatement ? original : merchant,
    ) &&
    matchesText(rule.originalStatementCriteria, original) &&
    matchesText(rule.merchantNameCriteria, merchant) &&
    matchesAmount(rule.amountCriteria, transaction.amount) &&
    (!rule.categoryIds?.length ||
      (transaction.category !== null && rule.categoryIds.includes(transaction.category.id))) &&
    (!rule.accountIds?.length || rule.accountIds.includes(transaction.account.id))
  );
}

async function matchingTransactions(
  session: MonarchAccess,
  rule: TransactionRuleInput,
): Promise<Transaction[]> {
  const transactions = await session.read((client) => client.getAllTransactions({ pageSize: 500 }));
  return transactions.filter((transaction) => matchesRule(transaction, rule));
}

async function captureUndo(
  client: MonarchClient,
  transactions: Transaction[],
): Promise<UndoStep[]> {
  return mapConcurrent(transactions, 8, async (transaction) =>
    transactionUndoStep(await client.getTransactionDetails(transaction.id)),
  );
}

async function captureGuards(
  client: MonarchClient,
  transactions: Transaction[],
): Promise<ChangeGuard[]> {
  return mapConcurrent(transactions, 8, async (transaction) =>
    transactionGuard(await client.getTransactionDetails(transaction.id)),
  );
}

function requireCreateRule(args: RuleArguments): void {
  if (!criteriaKeys.some((key) => args[key] !== undefined)) {
    invalidInput('A transaction rule requires at least one match criterion');
  }
  if (!actionKeys.some((key) => args[key] !== undefined)) {
    invalidInput('A transaction rule requires at least one action');
  }
}

export function registerRuleTools(
  server: McpServer,
  session: MonarchAccess,
  changes: ChangeStore,
): void {
  addTool(
    server,
    {
      name: 'get_transaction_rules',
      title: 'Get transaction rules',
      description:
        'List automatic transaction rules with their criteria, actions, IDs, and recent application counts.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const data = await session.read((client) => client.getTransactionRules());
      return {
        data,
        summary: `Retrieved ${data.transactionRules.length} transaction rules.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'preview_transaction_rule',
      title: 'Preview transaction rule',
      description:
        'Preview which existing transactions would match rule criteria without changing Monarch.',
      inputSchema: z.object(ruleShape),
      hints: READ_ONLY,
    },
    async (args) => {
      const input = ruleInput(args);
      const matches = await matchingTransactions(session, input);
      return {
        data: {
          matching_count: matches.length,
          sample: matches.slice(0, 25).map(compactTransaction),
          sample_truncated: matches.length > 25,
        },
        summary: `The rule matches ${matches.length} existing transactions.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'create_transaction_rule',
      title: 'Create transaction rule',
      description:
        'Create a future transaction rule, optionally apply it to existing matches, and record enough prior state to undo the definition and matched transactions.',
      inputSchema: z.object(ruleShape),
      hints: CREATE,
    },
    async (args) => {
      requireCreateRule(args);
      const input = ruleInput(args);
      const matches = input.applyToExistingTransactions
        ? await matchingTransactions(session, input)
        : [];
      const historicalUndo = matches.length
        ? await session.read((client) => captureUndo(client, matches))
        : [];
      const prepared = changes.prepare({
        tool: 'create_transaction_rule',
        affected_count: 1 + matches.length,
        reversible: false,
        reversibility_reason: 'The created rule ID is not known until Monarch responds.',
        undo: historicalUndo,
        snapshot: { input },
      });
      const created = await performPrepared(changes, prepared.id, () =>
        session.write((client) => client.createTransactionRule(input)),
      );
      const appliedCount = created.recentApplicationCount ?? matches.length;
      let exactUndo = !input.applyToExistingTransactions || appliedCount === matches.length;
      let guards: ChangeGuard[] = [
        {
          kind: 'rule',
          id: created.id,
          value: ruleDefinition(input),
          ...(created.recentApplicationCount !== undefined
            ? { recentApplicationCount: created.recentApplicationCount }
            : {}),
          ...(created.lastAppliedAt !== undefined ? { lastAppliedAt: created.lastAppliedAt } : {}),
        },
      ];
      activatePrepared(changes, prepared.id, {
        affected_count: 1 + appliedCount,
        reversible: exactUndo,
        reversibility_reason: exactUndo
          ? null
          : "Monarch's applied count differed from the locally previewed transaction set.",
        undo: [...historicalUndo, { operation: 'delete_transaction_rule', id: created.id }],
        guards,
      });
      if (exactUndo && matches.length) {
        try {
          guards = [...guards, ...(await session.read((client) => captureGuards(client, matches)))];
        } catch {
          exactUndo = false;
        }
      }
      const change = activatePrepared(changes, prepared.id, {
        reversible: exactUndo,
        reversibility_reason: exactUndo
          ? null
          : "Monarch's applied transaction set could not be captured exactly after the rule ran.",
        guards,
      });
      return {
        data: {
          rule: created,
          change_id: change.id,
          historical_match_count: appliedCount,
          reversible: exactUndo,
        },
        summary: `Created rule ${created.id}${appliedCount ? ` and applied it to ${appliedCount} existing transactions` : ''}; ${exactUndo ? `undo with ${change.id}` : `change ${change.id} needs manual review because Monarch's applied count differed from the preview`}.`,
        change: { id: change.id, affectedCount: 1 + appliedCount, reversible: exactUndo },
      };
    },
  );

  addTool(
    server,
    {
      name: 'update_transaction_rule',
      title: 'Update transaction rule',
      description:
        'Update only supplied fields on an existing rule while preserving all other criteria and actions.',
      inputSchema: z.object({ rule_id: z.string().min(1), ...ruleShape }),
      hints: UPDATE,
    },
    async ({ rule_id, ...args }) => {
      if (Object.values(args).every((value) => value === undefined)) {
        invalidInput('At least one rule field must be supplied');
      }
      const current = (
        await session.read((client) => client.getTransactionRules())
      ).transactionRules.find((rule) => rule.id === rule_id);
      if (!current) throw new Error(`Transaction rule ${rule_id} was not found`);
      const before = ruleInputFromApi(current);
      const restore = ruleRestoreInput(current);
      const requested = ruleInput(args);
      const merged = { ...before, ...requested };
      const matches = requested.applyToExistingTransactions
        ? await matchingTransactions(session, merged)
        : [];
      const historicalUndo = matches.length
        ? await session.read((client) => captureUndo(client, matches))
        : [];
      const prepared = changes.prepare({
        tool: 'update_transaction_rule',
        affected_count: 1 + matches.length,
        reversible: false,
        reversibility_reason:
          'The exact applied transaction count is not known until Monarch responds.',
        undo: [
          ...historicalUndo,
          { operation: 'update_transaction_rule', id: rule_id, values: restore },
        ],
      });
      const updated = await performPrepared(changes, prepared.id, () =>
        session.write((client) => client.updateTransactionRule(rule_id, requested)),
      );
      const appliedCount = requested.applyToExistingTransactions
        ? (updated.recentApplicationCount ?? matches.length)
        : 0;
      let exactUndo = !requested.applyToExistingTransactions || appliedCount === matches.length;
      let guards: ChangeGuard[] = [
        {
          kind: 'rule',
          id: rule_id,
          value: ruleDefinition(merged),
          ...(updated.recentApplicationCount !== undefined
            ? { recentApplicationCount: updated.recentApplicationCount }
            : {}),
          ...(updated.lastAppliedAt !== undefined ? { lastAppliedAt: updated.lastAppliedAt } : {}),
        },
      ];
      activatePrepared(changes, prepared.id, {
        affected_count: 1 + appliedCount,
        reversible: exactUndo,
        reversibility_reason: exactUndo
          ? null
          : "Monarch's applied count differed from the locally previewed transaction set.",
        guards,
      });
      if (exactUndo && matches.length) {
        try {
          guards = [...guards, ...(await session.read((client) => captureGuards(client, matches)))];
        } catch {
          exactUndo = false;
        }
      }
      const change = activatePrepared(changes, prepared.id, {
        reversible: exactUndo,
        reversibility_reason: exactUndo
          ? null
          : "Monarch's applied transaction set could not be captured exactly after the rule ran.",
        guards,
      });
      return {
        data: {
          rule: updated,
          change_id: change.id,
          historical_match_count: appliedCount,
          reversible: exactUndo,
        },
        summary: `Updated rule ${rule_id}${appliedCount ? ` and applied it to ${appliedCount} existing transactions` : ''}; ${exactUndo ? `undo with ${change.id}` : `change ${change.id} needs manual review because Monarch's applied count differed from the preview`}.`,
        change: { id: change.id, affectedCount: 1 + appliedCount, reversible: exactUndo },
      };
    },
  );

  addTool(
    server,
    {
      name: 'delete_transaction_rule',
      title: 'Delete transaction rule',
      description:
        'Delete a transaction rule. Transactions it already changed are not modified; the saved rule definition can be recreated with undo_change.',
      inputSchema: z.object({ rule_id: z.string().min(1) }),
      hints: REMOVE,
    },
    async ({ rule_id }) => {
      const current = (
        await session.read((client) => client.getTransactionRules())
      ).transactionRules.find((rule) => rule.id === rule_id);
      if (!current) throw new Error(`Transaction rule ${rule_id} was not found`);
      const prepared = changes.prepare({
        tool: 'delete_transaction_rule',
        affected_count: 1,
        reversible: true,
        undo: [{ operation: 'create_transaction_rule', values: ruleInputFromApi(current) }],
      });
      await performPrepared(changes, prepared.id, () =>
        session.write((client) => client.deleteTransactionRule(rule_id)),
      );
      const change = activatePrepared(changes, prepared.id);
      return {
        data: { deleted: true, rule_id, change_id: change.id },
        summary: `Deleted rule ${rule_id}; recreate it with ${change.id}.`,
        change: { id: change.id, affectedCount: 1, reversible: true },
      };
    },
  );
}
