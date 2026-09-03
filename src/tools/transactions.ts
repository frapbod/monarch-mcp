import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  activatePrepared,
  type ChangeStep,
  type ChangeStore,
  type TransactionGuard,
  type TransactionValues,
  journalMutation,
  observeMutationOutcome,
  selectedValues,
  selectedValuesMatch,
} from '../changes.js';
import { mapConcurrent } from '../concurrency.js';
import { compactTransaction } from '../projections.js';
import type { MonarchAccess } from '../session.js';
import {
  transactionSplitValues,
  transactionTagIds,
  transactionValues,
} from '../transaction-state.js';
import {
  CREATE,
  READ_ONLY,
  REMOVE,
  UPDATE,
  addTool,
  assertDateRange,
  dateSchema,
  detailSchema,
  invalidInput,
  reportProgress,
  requestCancelled,
  throwIfCancelled,
} from '../tool.js';

const transactionId = z.string().min(1).describe('Monarch transaction ID');
const categoryId = z.string().min(1).describe('Monarch category ID');

const transactionUpdateShape = {
  category_id: categoryId.optional(),
  merchant_name: z.string().min(1).optional(),
  goal_id: z.string().optional().describe('Monarch goal ID; use an empty string to unlink'),
  amount: z.number().optional(),
  date: dateSchema.optional(),
  notes: z.string().optional(),
  hidden_from_reports: z.boolean().optional(),
  needs_review: z.boolean().optional(),
};

type TransactionUpdate = {
  readonly category_id?: string | undefined;
  readonly merchant_name?: string | undefined;
  readonly goal_id?: string | undefined;
  readonly amount?: number | undefined;
  readonly date?: string | undefined;
  readonly notes?: string | undefined;
  readonly hidden_from_reports?: boolean | undefined;
  readonly needs_review?: boolean | undefined;
};

interface BulkResult {
  readonly transaction_id: string;
  readonly status: 'updated' | 'ambiguous' | 'failed' | 'cancelled';
  readonly error?: string;
}

type BulkPlan =
  | { readonly kind: 'failed'; readonly result: BulkResult }
  | {
      readonly kind: 'write';
      readonly transaction_id: string;
      readonly expected: TransactionValues;
      readonly undo: Extract<ChangeStep, { operation: 'update_transaction' }>;
    };

function clientUpdate(update: TransactionUpdate): TransactionValues {
  return {
    ...(update.category_id !== undefined ? { categoryId: update.category_id } : {}),
    ...(update.merchant_name !== undefined ? { merchantName: update.merchant_name } : {}),
    ...(update.goal_id !== undefined ? { goalId: update.goal_id } : {}),
    ...(update.amount !== undefined ? { amount: update.amount } : {}),
    ...(update.date !== undefined ? { date: update.date } : {}),
    ...(update.notes !== undefined ? { notes: update.notes } : {}),
    ...(update.hidden_from_reports !== undefined
      ? { hideFromReports: update.hidden_from_reports }
      : {}),
    ...(update.needs_review !== undefined ? { needsReview: update.needs_review } : {}),
  };
}

function observeTransactionUpdate(session: MonarchAccess, id: string, expected: TransactionValues) {
  return observeMutationOutcome(
    () => session.write((client) => client.updateTransaction(id, expected)),
    async () => {
      const after = await session.read((client) => client.getTransactionDetails(id));
      const actual = transactionValues(after);
      return {
        verified: selectedValuesMatch(actual, expected),
        guard: {
          kind: 'transaction' as const,
          id,
          values: selectedValues(actual, expected),
        },
      };
    },
  );
}

export function registerTransactionTools(
  server: McpServer,
  session: MonarchAccess,
  changes: ChangeStore,
): void {
  addTool(
    server,
    {
      name: 'get_transactions',
      title: 'Search transactions',
      description:
        'Search and filter transactions with exact pagination. Compact results retain transaction, account, category, merchant, and tag IDs.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
        search: z.string().optional(),
        category_ids: z.array(categoryId).optional(),
        account_ids: z.array(z.string().min(1)).optional(),
        tag_ids: z.array(z.string().min(1)).optional(),
        has_attachments: z.boolean().optional(),
        has_notes: z.boolean().optional(),
        hidden_from_reports: z.boolean().optional(),
        is_split: z.boolean().optional(),
        is_recurring: z.boolean().optional(),
        imported_from_mint: z.boolean().optional(),
        synced_from_institution: z.boolean().optional(),
        needs_review: z.boolean().optional(),
        detail: detailSchema,
      }),
      hints: READ_ONLY,
    },
    async (args) => {
      assertDateRange(args.start_date, args.end_date);
      const response = await session.read((client) =>
        client.getTransactions({
          limit: args.limit,
          offset: args.offset,
          ...(args.start_date ? { startDate: args.start_date } : {}),
          ...(args.end_date ? { endDate: args.end_date } : {}),
          ...(args.search !== undefined ? { search: args.search } : {}),
          ...(args.category_ids ? { categoryIds: args.category_ids } : {}),
          ...(args.account_ids ? { accountIds: args.account_ids } : {}),
          ...(args.tag_ids ? { tagIds: args.tag_ids } : {}),
          ...(args.has_attachments !== undefined ? { hasAttachments: args.has_attachments } : {}),
          ...(args.has_notes !== undefined ? { hasNotes: args.has_notes } : {}),
          ...(args.hidden_from_reports !== undefined
            ? { hiddenFromReports: args.hidden_from_reports }
            : {}),
          ...(args.is_split !== undefined ? { isSplit: args.is_split } : {}),
          ...(args.is_recurring !== undefined ? { isRecurring: args.is_recurring } : {}),
          ...(args.imported_from_mint !== undefined
            ? { importedFromMint: args.imported_from_mint }
            : {}),
          ...(args.synced_from_institution !== undefined
            ? { syncedFromInstitution: args.synced_from_institution }
            : {}),
          ...(args.needs_review !== undefined ? { needsReview: args.needs_review } : {}),
        }),
      );
      const total = response.allTransactions.totalCount;
      const results = response.allTransactions.results;
      const transactions = args.detail === 'full' ? results : results.map(compactTransaction);
      const nextOffset = args.offset + results.length;
      return {
        data: { transactions },
        summary: `Returned ${results.length} of ${total} matching transactions.`,
        page: {
          limit: args.limit,
          offset: args.offset,
          returned: results.length,
          total,
          next_offset: nextOffset < total ? nextOffset : null,
        },
      };
    },
  );

  addTool(
    server,
    {
      name: 'get_transactions_summary',
      title: 'Get transaction summary',
      description: 'Get aggregate transaction totals, averages, counts, and date bounds.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const response = await session.read((client) => client.getTransactionsSummary());
      const aggregate = Array.isArray(response.aggregates)
        ? response.aggregates[0]
        : response.aggregates;
      if (!aggregate?.summary) throw new Error('Monarch returned no transaction summary');
      return {
        data: { summary: aggregate.summary },
        summary: 'Retrieved aggregate transaction summary.',
      };
    },
  );

  addTool(
    server,
    {
      name: 'get_transaction',
      title: 'Get transaction',
      description: 'Get full details for one transaction.',
      inputSchema: z.object({ transaction_id: transactionId }),
      hints: READ_ONLY,
    },
    async ({ transaction_id }) => {
      const data = await session.read((client) => client.getTransactionDetails(transaction_id));
      return { data, summary: `Retrieved transaction ${transaction_id}.` };
    },
  );

  addTool(
    server,
    {
      name: 'get_transaction_splits',
      title: 'Get transaction splits',
      description: 'Get the split legs for one transaction.',
      inputSchema: z.object({ transaction_id: transactionId }),
      hints: READ_ONLY,
    },
    async ({ transaction_id }) => {
      const data = await session.read((client) => client.getTransactionSplits(transaction_id));
      return { data, summary: `Retrieved splits for transaction ${transaction_id}.` };
    },
  );

  addTool(
    server,
    {
      name: 'get_transaction_categories',
      title: 'List transaction categories',
      description: 'List all transaction categories with IDs and category groups.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const data = await session.read((client) => client.getTransactionCategories());
      return { data, summary: `Retrieved ${data.categories.length} transaction categories.` };
    },
  );

  addTool(
    server,
    {
      name: 'get_transaction_category_groups',
      title: 'List category groups',
      description: 'List all transaction category groups with IDs.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const data = await session.read((client) => client.getTransactionCategoryGroups());
      return { data, summary: `Retrieved ${data.categoryGroups.length} category groups.` };
    },
  );

  addTool(
    server,
    {
      name: 'get_transaction_tags',
      title: 'List transaction tags',
      description: 'List all transaction tags with IDs, names, colors, and usage counts.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const data = await session.read((client) => client.getTransactionTags());
      return { data, summary: `Retrieved ${data.tags.length} transaction tags.` };
    },
  );

  addTool(
    server,
    {
      name: 'create_transaction',
      title: 'Create transaction',
      description: 'Create a manual transaction in an account.',
      inputSchema: z.object({
        date: dateSchema,
        account_id: z.string().min(1),
        amount: z.number(),
        merchant_name: z.string().min(1),
        category_id: categoryId,
        notes: z.string().optional(),
        update_account_balance: z.boolean().default(false),
      }),
      hints: CREATE,
    },
    async (args) => {
      const account = args.update_account_balance
        ? (await session.read((client) => client.getAccounts())).accounts.find(
            ({ id }) => id === args.account_id,
          )
        : undefined;
      if (args.update_account_balance && !account) {
        throw new Error(`Account ${args.account_id} was not found`);
      }
      const request = {
        date: args.date,
        accountId: args.account_id,
        amount: args.amount,
        merchantName: args.merchant_name,
        categoryId: args.category_id,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        updateBalance: args.update_account_balance,
      };
      const accountUndo: ChangeStep[] = account
        ? [
            {
              operation: 'update_account',
              id: account.id,
              values: { accountBalance: account.displayBalance },
            },
          ]
        : [];
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'create_transaction',
          affected_count: account ? 2 : 1,
          reversible: false,
          reversibility_reason: 'The created transaction ID is not known until Monarch responds.',
          undo: accountUndo,
          snapshot: { request },
        },
        () => session.write((client) => client.createTransaction(request)),
        (result) => {
          const id = result.createTransaction.transaction?.id;
          if (!id) throw new Error('Monarch did not create the transaction');
          return {
            reversible: true,
            reversibility_reason: null,
            undo: [...accountUndo, { operation: 'delete_transaction', id }],
            guards: [
              {
                kind: 'transaction',
                id,
                values: {
                  date: args.date,
                  amount: args.amount,
                  merchantName: args.merchant_name,
                  categoryId: args.category_id,
                  goalId: '',
                  notes: args.notes ?? '',
                  hideFromReports: false,
                  needsReview: false,
                },
                tagIds: [],
                splits: [],
              },
            ],
          };
        },
      );
      const transactionId = data.createTransaction.transaction?.id;
      if (!transactionId) throw new Error(`Monarch did not create the transaction`);
      return {
        data: { ...data, change_id: change.id },
        summary: `Created transaction for ${args.merchant_name}; undo with ${change.id}.`,
        change: { id: change.id, affectedCount: account ? 2 : 1, reversible: true },
      };
    },
  );

  addTool(
    server,
    {
      name: 'update_transaction',
      title: 'Update transaction',
      description:
        'Update only the supplied transaction fields: category, merchant, goal, amount, date, notes, report visibility, or review state.',
      inputSchema: z.object({
        transaction_id: transactionId,
        ...transactionUpdateShape,
      }),
      hints: UPDATE,
    },
    async ({ transaction_id, ...updates }) => {
      if (Object.values(updates).every((value) => value === undefined)) {
        invalidInput('At least one transaction field must be supplied');
      }
      const before = await session.read((client) => client.getTransactionDetails(transaction_id));
      const expected = clientUpdate(updates);
      const previous = selectedValues(transactionValues(before), expected);
      const prepared = changes.prepare({
        tool: 'update_transaction',
        affected_count: 1,
        reversible: true,
        undo: [{ operation: 'update_transaction', id: transaction_id, values: previous }],
        redo: [{ operation: 'update_transaction', id: transaction_id, values: expected }],
      });
      const { result, writeError, verified, guard } = await observeTransactionUpdate(
        session,
        transaction_id,
        expected,
      );
      const active = activatePrepared(changes, prepared.id, {
        guards: guard ? [guard] : [],
      });
      const change = verified ? active : changes.markUncertain(active.id);
      return {
        data: {
          result,
          change_id: change.id,
          status: verified ? 'updated' : 'ambiguous',
          ...(writeError !== undefined ? { error: writeError } : {}),
        },
        summary: verified
          ? `Updated transaction ${transaction_id}; undo with ${change.id}.`
          : `Transaction ${transaction_id} could not be verified after the write; restore with ${change.id}.`,
        ambiguous: !verified,
        change: { id: change.id, affectedCount: 1, reversible: true },
      };
    },
  );

  addTool(
    server,
    {
      name: 'bulk_update_transactions',
      title: 'Bulk update transactions',
      description:
        'Apply explicit field changes to up to 500 transactions, verify each result, and record one reversible change. Returns per-transaction outcomes.',
      inputSchema: z.object({
        updates: z
          .array(z.object({ transaction_id: transactionId, ...transactionUpdateShape }))
          .min(1)
          .max(500),
      }),
      hints: UPDATE,
    },
    async ({ updates }, context) => {
      throwIfCancelled(context);
      if (new Set(updates.map(({ transaction_id }) => transaction_id)).size !== updates.length) {
        invalidInput('Each transaction_id may appear only once');
      }
      let preparedCount = 0;
      const plans: BulkPlan[] = await mapConcurrent(
        updates,
        8,
        async ({ transaction_id, ...fields }) => {
          throwIfCancelled(
            context,
            `Bulk update cancelled while preparing transaction ${preparedCount + 1} of ${updates.length}`,
          );
          let plan: BulkPlan;
          if (Object.values(fields).every((value) => value === undefined)) {
            plan = {
              kind: 'failed' as const,
              result: {
                transaction_id,
                status: 'failed' as const,
                error: 'At least one transaction field must be supplied',
              },
            };
          } else {
            try {
              const before = await session.read((client) =>
                client.getTransactionDetails(transaction_id),
              );
              plan = {
                kind: 'write' as const,
                transaction_id,
                expected: clientUpdate(fields),
                undo: {
                  operation: 'update_transaction' as const,
                  id: transaction_id,
                  values: selectedValues(transactionValues(before), clientUpdate(fields)),
                },
              };
            } catch (error) {
              plan = {
                kind: 'failed' as const,
                result: {
                  transaction_id,
                  status: 'failed' as const,
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            }
          }
          preparedCount += 1;
          await reportProgress(
            context,
            preparedCount,
            updates.length * 2,
            `Prepared ${preparedCount} of ${updates.length} transaction updates`,
          );
          return plan;
        },
      );
      throwIfCancelled(context, 'Bulk update cancelled before any Monarch changes were attempted');
      const writable = plans.filter((plan) => plan.kind === 'write');
      const prepared = writable.length
        ? changes.prepare({
            tool: 'bulk_update_transactions',
            affected_count: writable.length,
            reversible: true,
            undo: writable.map(({ undo }) => undo),
          })
        : undefined;
      let processedCount = 0;
      const outcomes = await mapConcurrent(plans, 4, async (plan) => {
        let outcome: {
          result: BulkResult;
          guard?: TransactionGuard;
          undo?: ChangeStep;
          redo?: ChangeStep;
          attempted: boolean;
        };
        if (plan.kind === 'failed') {
          outcome = { result: plan.result, attempted: false };
        } else if (requestCancelled(context)) {
          outcome = {
            result: { transaction_id: plan.transaction_id, status: 'cancelled' },
            attempted: false,
          };
        } else {
          const { transaction_id, expected } = plan;
          const { writeError, verified, guard } = await observeTransactionUpdate(
            session,
            transaction_id,
            expected,
          );
          outcome = {
            result: {
              transaction_id,
              status: verified ? ('updated' as const) : ('ambiguous' as const),
              ...(writeError !== undefined ? { error: writeError } : {}),
            },
            ...(guard ? { guard } : {}),
            undo: plan.undo,
            redo: {
              operation: 'update_transaction' as const,
              id: transaction_id,
              values: expected,
            },
            attempted: true,
          };
        }
        processedCount += 1;
        await reportProgress(
          context,
          updates.length + processedCount,
          updates.length * 2,
          `Processed ${processedCount} of ${updates.length} transaction updates`,
        );
        return outcome;
      });
      const results: BulkResult[] = outcomes.map(({ result }) => result);
      const updatedCount = results.filter(({ status }) => status === 'updated').length;
      const ambiguousCount = results.filter(({ status }) => status === 'ambiguous').length;
      const failedCount = results.filter(({ status }) => status === 'failed').length;
      const cancelledCount = results.filter(({ status }) => status === 'cancelled').length;
      const attempted = outcomes.filter(({ attempted }) => attempted);
      const active = prepared
        ? activatePrepared(changes, prepared.id, {
            affected_count: attempted.length,
            undo: attempted.flatMap((outcome) => (outcome.undo ? [outcome.undo] : [])),
            redo: attempted.flatMap((outcome) => (outcome.redo ? [outcome.redo] : [])),
            guards: attempted.flatMap((outcome) => (outcome.guard ? [outcome.guard] : [])),
          })
        : undefined;
      const change =
        active && attempted.length
          ? ambiguousCount > 0
            ? changes.markUncertain(active.id)
            : active
          : undefined;
      if (active && !change) changes.markUndone(active.id);
      return {
        data: {
          results,
          updated_count: updatedCount,
          ambiguous_count: ambiguousCount,
          failed_count: failedCount,
          cancelled_count: cancelledCount,
          ...(change ? { change_id: change.id } : {}),
        },
        summary: `Verified ${updatedCount}, ambiguous ${ambiguousCount}, failed ${failedCount}, and cancelled ${cancelledCount} of ${results.length} transaction updates${change ? `; undo attempted writes with ${change.id}` : ''}.`,
        cancelled: cancelledCount > 0 || requestCancelled(context),
        ambiguous: ambiguousCount > 0,
        ...(change
          ? { change: { id: change.id, affectedCount: attempted.length, reversible: true } }
          : {}),
      };
    },
  );

  addTool(
    server,
    {
      name: 'delete_transaction',
      title: 'Delete transaction',
      description: 'Delete a transaction by ID.',
      inputSchema: z.object({ transaction_id: transactionId }),
      hints: REMOVE,
    },
    async ({ transaction_id }) => {
      const details = await session.read((client) => client.getTransactionDetails(transaction_id));
      const { value: deleted, change } = await journalMutation(
        changes,
        {
          tool: 'delete_transaction',
          affected_count: 1,
          reversible: false,
          reversibility_reason:
            'A recreated transaction receives a new ID and may not preserve synced-account semantics.',
          undo: [],
          snapshot: { details },
        },
        () => session.write((client) => client.deleteTransaction(transaction_id)),
        (result) => {
          if (!result) throw new Error(`Monarch did not delete transaction ${transaction_id}`);
          return {};
        },
      );
      return {
        data: { deleted, transaction_id, change_id: change.id },
        summary: `Deleted transaction ${transaction_id}; recorded as ${change.id} (not automatically reversible).`,
        change: { id: change.id, affectedCount: 1, reversible: false },
      };
    },
  );

  addTool(
    server,
    {
      name: 'set_transaction_splits',
      title: 'Set transaction splits',
      description:
        'Replace all split legs on a transaction. Amounts must sum to the parent amount; pass an empty splits array to remove splits.',
      inputSchema: z.object({
        transaction_id: transactionId,
        splits: z.array(
          z.object({
            merchant_name: z.string().min(1),
            amount: z.number(),
            category_id: categoryId,
          }),
        ),
      }),
      hints: UPDATE,
    },
    async ({ transaction_id, splits }) => {
      const before = await session.read((client) => client.getTransactionSplits(transaction_id));
      const requestedSplits = splits.map((split) => ({
        merchantName: split.merchant_name,
        amount: split.amount,
        categoryId: split.category_id,
      }));
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'set_transaction_splits',
          affected_count: 1,
          reversible: true,
          undo: [
            {
              operation: 'set_transaction_splits',
              id: transaction_id,
              splits: transactionSplitValues(before),
            },
          ],
          redo: [
            {
              operation: 'set_transaction_splits',
              id: transaction_id,
              splits: requestedSplits,
            },
          ],
        },
        () =>
          session.write((client) =>
            client.updateTransactionSplits(transaction_id, requestedSplits),
          ),
        () => ({
          guards: [{ kind: 'transaction', id: transaction_id, splits: requestedSplits }],
        }),
      );
      return {
        data: { ...data, change_id: change.id },
        summary: `Set ${splits.length} split legs on transaction ${transaction_id}; undo with ${change.id}.`,
        change: { id: change.id, affectedCount: 1, reversible: true },
      };
    },
  );

  addTool(
    server,
    {
      name: 'set_transaction_tags',
      title: 'Set transaction tags',
      description:
        'Replace all tags on a transaction. Pass an empty tag_ids array to remove all tags.',
      inputSchema: z.object({
        transaction_id: transactionId,
        tag_ids: z.array(z.string().min(1)),
      }),
      hints: UPDATE,
    },
    async ({ transaction_id, tag_ids }) => {
      const before = await session.read((client) => client.getTransactionDetails(transaction_id));
      const oldTags = transactionTagIds(before);
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'set_transaction_tags',
          affected_count: 1,
          reversible: true,
          undo: [{ operation: 'set_transaction_tags', id: transaction_id, tagIds: oldTags }],
          redo: [{ operation: 'set_transaction_tags', id: transaction_id, tagIds: tag_ids }],
        },
        () => session.write((client) => client.setTransactionTags(transaction_id, tag_ids)),
        () => ({ guards: [{ kind: 'transaction', id: transaction_id, tagIds: tag_ids }] }),
      );
      return {
        data: { ...data, change_id: change.id },
        summary: `Set ${tag_ids.length} tags on transaction ${transaction_id}; undo with ${change.id}.`,
        change: { id: change.id, affectedCount: 1, reversible: true },
      };
    },
  );

  addTool(
    server,
    {
      name: 'create_transaction_tag',
      title: 'Create transaction tag',
      description: 'Create a reusable transaction tag.',
      inputSchema: z.object({
        name: z.string().min(1),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .describe('Hex color such as #4F46E5'),
      }),
      hints: CREATE,
    },
    async ({ name, color }) => {
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'create_transaction_tag',
          affected_count: 1,
          reversible: false,
          reversibility_reason: 'The created tag ID is not known until Monarch responds.',
          undo: [],
          snapshot: { name, color },
        },
        () => session.write((client) => client.createTransactionTag(name, color)),
        (result) => {
          const created = result.createTransactionTag.tag;
          if (!created) throw new Error(`Monarch did not create transaction tag "${name}"`);
          return {
            reversible: true,
            reversibility_reason: null,
            undo: [{ operation: 'delete_transaction_tag', id: created.id }],
            guards: [{ kind: 'tag', id: created.id, name, color }],
          };
        },
      );
      const tag = data.createTransactionTag.tag;
      if (!tag) throw new Error(`Monarch did not create transaction tag "${name}"`);
      return {
        data: { ...data, change_id: change.id },
        summary: `Created transaction tag "${name}"; undo with ${change.id}.`,
        change: { id: change.id, affectedCount: 1, reversible: true },
      };
    },
  );

  addTool(
    server,
    {
      name: 'delete_transaction_tag',
      title: 'Delete transaction tag',
      description: 'Delete a reusable transaction tag by ID.',
      inputSchema: z.object({ tag_id: z.string().min(1).describe('Monarch transaction tag ID') }),
      hints: REMOVE,
    },
    async ({ tag_id }) => {
      const tag = (await session.read((client) => client.getTransactionTags())).tags.find(
        ({ id }) => id === tag_id,
      );
      if (!tag) throw new Error(`Transaction tag ${tag_id} was not found`);
      const affected = await session.read((client) =>
        client.getAllTransactions({ tagIds: [tag_id], pageSize: 500 }),
      );
      const { change } = await journalMutation(
        changes,
        {
          tool: 'delete_transaction_tag',
          affected_count: 1 + affected.length,
          reversible: false,
          reversibility_reason:
            'Recreating a tag gives it a new ID and cannot restore its transaction links atomically.',
          undo: [],
          snapshot: { tag, transaction_ids: affected.map(({ id }) => id) },
        },
        () => session.write((client) => client.deleteTransactionTag(tag_id)),
      );
      return {
        data: { deleted: true, tag_id, change_id: change.id },
        summary: `Deleted transaction tag ${tag_id}; recorded as ${change.id} (not automatically reversible).`,
        change: { id: change.id, affectedCount: 1 + affected.length, reversible: false },
      };
    },
  );

  addTool(
    server,
    {
      name: 'create_transaction_category',
      title: 'Create transaction category',
      description: 'Create a category in an existing category group.',
      inputSchema: z.object({
        group_id: z.string().min(1),
        name: z.string().min(1),
        icon: z.string().optional(),
        rollover_start_month: dateSchema.optional(),
        rollover_enabled: z.boolean().default(false),
      }),
      hints: CREATE,
    },
    async ({ group_id, name, icon, rollover_start_month, rollover_enabled }) => {
      const request = {
        groupId: group_id,
        name,
        ...(icon !== undefined ? { icon } : {}),
        ...(rollover_start_month !== undefined ? { rolloverStartMonth: rollover_start_month } : {}),
        rolloverEnabled: rollover_enabled,
      };
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'create_transaction_category',
          affected_count: 1,
          reversible: false,
          reversibility_reason: 'The created category ID is not known until Monarch responds.',
          undo: [],
          snapshot: { request },
        },
        () => session.write((client) => client.createTransactionCategory(request)),
        (result) => {
          const created = result.createCategory.category;
          if (!created) throw new Error(`Monarch did not create transaction category "${name}"`);
          return {
            reversible: true,
            reversibility_reason: null,
            undo: [{ operation: 'delete_transaction_category', id: created.id }],
            guards: [{ kind: 'category', id: created.id, name, groupId: group_id }],
          };
        },
      );
      const category = data.createCategory.category;
      if (!category) throw new Error(`Monarch did not create transaction category "${name}"`);
      return {
        data: { ...data, change_id: change.id },
        summary: `Created transaction category "${name}"; undo with ${change.id}.`,
        change: { id: change.id, affectedCount: 1, reversible: true },
      };
    },
  );

  addTool(
    server,
    {
      name: 'delete_transaction_category',
      title: 'Delete transaction category',
      description:
        'Delete a category, optionally moving its transactions to another category first.',
      inputSchema: z.object({
        category_id: categoryId,
        move_to_category_id: categoryId.optional(),
      }),
      hints: REMOVE,
    },
    async ({ category_id, move_to_category_id }) => {
      const category = (
        await session.read((client) => client.getTransactionCategories())
      ).categories.find(({ id }) => id === category_id);
      if (!category) throw new Error(`Transaction category ${category_id} was not found`);
      const affected = await session.read((client) =>
        client.getAllTransactions({ categoryIds: [category_id], pageSize: 500 }),
      );
      const { value: deleted, change } = await journalMutation(
        changes,
        {
          tool: 'delete_transaction_category',
          affected_count: 1 + affected.length,
          reversible: false,
          reversibility_reason:
            'Recreating a category gives it a new ID and cannot atomically restore moved transaction links.',
          undo: [],
          snapshot: {
            category,
            move_to_category_id: move_to_category_id ?? null,
            transaction_ids: affected.map(({ id }) => id),
          },
        },
        () =>
          session.write((client) =>
            client.deleteTransactionCategory(category_id, move_to_category_id),
          ),
        (result) => {
          if (!result) throw new Error(`Monarch did not delete category ${category_id}`);
          return {};
        },
      );
      return {
        data: { deleted, category_id, change_id: change.id },
        summary: `Deleted category ${category_id}; recorded as ${change.id} (not automatically reversible).`,
        change: { id: change.id, affectedCount: 1 + affected.length, reversible: false },
      };
    },
  );
}
