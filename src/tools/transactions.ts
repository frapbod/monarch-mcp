import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { compactTransaction } from '../projections.js';
import type { MonarchAccess } from '../session.js';
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
} from '../tool.js';

const transactionId = z.string().min(1).describe('Monarch transaction ID');
const categoryId = z.string().min(1).describe('Monarch category ID');

export function registerTransactionTools(server: McpServer, session: MonarchAccess): void {
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
      const data = await session.write((client) =>
        client.createTransaction({
          date: args.date,
          accountId: args.account_id,
          amount: args.amount,
          merchantName: args.merchant_name,
          categoryId: args.category_id,
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
          updateBalance: args.update_account_balance,
        }),
      );
      return { data, summary: `Created transaction for ${args.merchant_name}.` };
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
        category_id: categoryId.optional(),
        merchant_name: z.string().min(1).optional(),
        goal_id: z.string().min(1).optional(),
        amount: z.number().optional(),
        date: dateSchema.optional(),
        notes: z.string().optional(),
        hidden_from_reports: z.boolean().optional(),
        needs_review: z.boolean().optional(),
      }),
      hints: UPDATE,
    },
    async ({ transaction_id, ...updates }) => {
      if (Object.values(updates).every((value) => value === undefined)) {
        invalidInput('At least one transaction field must be supplied');
      }
      const data = await session.write((client) =>
        client.updateTransaction(transaction_id, {
          ...(updates.category_id !== undefined ? { categoryId: updates.category_id } : {}),
          ...(updates.merchant_name !== undefined ? { merchantName: updates.merchant_name } : {}),
          ...(updates.goal_id !== undefined ? { goalId: updates.goal_id } : {}),
          ...(updates.amount !== undefined ? { amount: updates.amount } : {}),
          ...(updates.date !== undefined ? { date: updates.date } : {}),
          ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
          ...(updates.hidden_from_reports !== undefined
            ? { hideFromReports: updates.hidden_from_reports }
            : {}),
          ...(updates.needs_review !== undefined ? { needsReview: updates.needs_review } : {}),
        }),
      );
      return { data, summary: `Updated transaction ${transaction_id}.` };
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
      const deleted = await session.write((client) => client.deleteTransaction(transaction_id));
      return {
        data: { deleted, transaction_id },
        summary: `Deleted transaction ${transaction_id}.`,
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
      const data = await session.write((client) =>
        client.updateTransactionSplits(
          transaction_id,
          splits.map((split) => ({
            merchantName: split.merchant_name,
            amount: split.amount,
            categoryId: split.category_id,
          })),
        ),
      );
      return {
        data,
        summary: `Set ${splits.length} split legs on transaction ${transaction_id}.`,
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
      const data = await session.write((client) =>
        client.setTransactionTags(transaction_id, tag_ids),
      );
      return { data, summary: `Set ${tag_ids.length} tags on transaction ${transaction_id}.` };
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
      const data = await session.write((client) => client.createTransactionTag(name, color));
      return { data, summary: `Created transaction tag "${name}".` };
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
      await session.write((client) => client.deleteTransactionTag(tag_id));
      return { data: { deleted: true, tag_id }, summary: `Deleted transaction tag ${tag_id}.` };
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
      const data = await session.write((client) =>
        client.createTransactionCategory({
          groupId: group_id,
          name,
          ...(icon !== undefined ? { icon } : {}),
          ...(rollover_start_month !== undefined
            ? { rolloverStartMonth: rollover_start_month }
            : {}),
          rolloverEnabled: rollover_enabled,
        }),
      );
      return { data, summary: `Created transaction category "${name}".` };
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
      const deleted = await session.write((client) =>
        client.deleteTransactionCategory(category_id, move_to_category_id),
      );
      return { data: { deleted, category_id }, summary: `Deleted category ${category_id}.` };
    },
  );
}
