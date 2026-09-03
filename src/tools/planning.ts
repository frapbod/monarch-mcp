import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { budgetAmount } from '../budget-state.js';
import {
  activatePrepared,
  type ChangeStore,
  journalMutation,
  observeMutationOutcome,
} from '../changes.js';
import type { MonarchAccess } from '../session.js';
import { READ_ONLY, UPDATE, addTool, assertDateRange, dateSchema, invalidInput } from '../tool.js';
import { recurringMatches, recurringValues } from '../transaction-state.js';

const rangeSchema = z.object({
  start_date: dateSchema.optional(),
  end_date: dateSchema.optional(),
});

function monthStart(date = new Date()): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

export function registerPlanningTools(
  server: McpServer,
  session: MonarchAccess,
  changes: ChangeStore,
): void {
  addTool(
    server,
    {
      name: 'get_budgets',
      title: 'Get budgets',
      description:
        'Get planned, actual, remaining, and rollover amounts by category and month. Omit both dates for the previous through next month.',
      inputSchema: rangeSchema,
      hints: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      assertDateRange(start_date, end_date);
      const data = await session.read((client) => client.getBudgets(start_date, end_date));
      return { data, summary: 'Retrieved Monarch budget data.' };
    },
  );

  addTool(
    server,
    {
      name: 'get_goals',
      title: 'Get goals',
      description:
        'List goals with IDs, status, priority, planned contributions, and monthly contribution totals.',
      inputSchema: rangeSchema,
      hints: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      assertDateRange(start_date, end_date);
      const data = await session.read((client) => client.getBudgets(start_date, end_date));
      return {
        data: { goals: data.goalsV2 },
        summary: `Retrieved ${data.goalsV2.length} Monarch goals.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'set_budget_amount',
      title: 'Set budget amount',
      description:
        'Set a monthly budget for exactly one category or category group. Use amount 0 to clear it.',
      inputSchema: z.object({
        amount: z.number(),
        category_id: z.string().min(1).optional(),
        category_group_id: z.string().min(1).optional(),
        start_date: dateSchema.optional(),
        apply_to_future: z.boolean().default(false),
      }),
      hints: UPDATE,
    },
    async ({ amount, category_id, category_group_id, start_date, apply_to_future }) => {
      if ((category_id === undefined) === (category_group_id === undefined)) {
        invalidInput('Supply exactly one of category_id or category_group_id');
      }
      const budgetOwnerId = category_id ?? category_group_id;
      if (!budgetOwnerId) invalidInput('Supply a category or category group ID');
      const effectiveStart = start_date ?? monthStart();
      const before = await session.read((client) =>
        client.getBudgets(effectiveStart, effectiveStart),
      );
      const previousAmount = budgetAmount(
        before.budgetData,
        category_id ? 'category' : 'category_group',
        budgetOwnerId,
        effectiveStart,
      );
      const reversible = !apply_to_future;
      const request = {
        amount,
        ...(category_id ? { categoryId: category_id } : {}),
        ...(category_group_id ? { categoryGroupId: category_group_id } : {}),
        startDate: effectiveStart,
        applyToFuture: apply_to_future,
      };
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'set_budget_amount',
          affected_count: 1,
          reversible,
          ...(reversible
            ? {}
            : {
                reversibility_reason:
                  'Monarch does not expose the complete open-ended future budget state changed by apply_to_future.',
              }),
          undo: reversible
            ? [
                {
                  operation: 'set_budget_amount',
                  values: {
                    amount: previousAmount,
                    ...(category_id ? { categoryId: category_id } : {}),
                    ...(category_group_id ? { categoryGroupId: category_group_id } : {}),
                    startDate: effectiveStart,
                    applyToFuture: false,
                  },
                },
              ]
            : [],
          ...(reversible
            ? {
                redo: [
                  { operation: 'set_budget_amount', values: { ...request, applyToFuture: false } },
                ],
              }
            : {}),
          snapshot: { previous_amount: previousAmount, start_date: effectiveStart },
        },
        () => session.write((client) => client.setBudgetAmount(request)),
        () => ({
          guards: reversible
            ? [
                {
                  kind: 'budget',
                  values: {
                    amount,
                    ...(category_id ? { categoryId: category_id } : {}),
                    ...(category_group_id ? { categoryGroupId: category_group_id } : {}),
                    startDate: effectiveStart,
                    applyToFuture: false,
                  },
                },
              ]
            : [],
        }),
      );
      return {
        data: { ...data, change_id: change.id },
        summary: reversible
          ? `Set budget amount to ${amount}; undo with ${change.id}.`
          : `Set this and future budget amounts to ${amount}; recorded as ${change.id} (not automatically reversible).`,
        change: { id: change.id, affectedCount: 1, reversible },
      };
    },
  );

  addTool(
    server,
    {
      name: 'get_cashflow',
      title: 'Get cash flow',
      description:
        'Get income and expense aggregates grouped by category, category group, and merchant. Omit both dates for the current month.',
      inputSchema: rangeSchema,
      hints: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      assertDateRange(start_date, end_date);
      const data = await session.read((client) =>
        client.getCashflow({
          ...(start_date ? { startDate: start_date } : {}),
          ...(end_date ? { endDate: end_date } : {}),
        }),
      );
      return { data, summary: 'Retrieved Monarch cash flow breakdown.' };
    },
  );

  addTool(
    server,
    {
      name: 'get_cashflow_summary',
      title: 'Get cash flow summary',
      description:
        'Get exact aggregate income, expenses, savings, and savings rate for a date range. Omit both dates for the current month.',
      inputSchema: rangeSchema,
      hints: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      assertDateRange(start_date, end_date);
      const data = await session.read((client) =>
        client.getCashflowSummary({
          ...(start_date ? { startDate: start_date } : {}),
          ...(end_date ? { endDate: end_date } : {}),
        }),
      );
      return { data, summary: 'Retrieved Monarch cash flow summary.' };
    },
  );

  addTool(
    server,
    {
      name: 'get_recurring_transactions',
      title: 'Get recurring transactions',
      description:
        'Get upcoming recurring bills, subscriptions, transfers, and income. Omit both dates for the current month.',
      inputSchema: rangeSchema,
      hints: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      assertDateRange(start_date, end_date);
      const data = await session.read((client) =>
        client.getRecurringTransactions(start_date, end_date),
      );
      return { data, summary: 'Retrieved upcoming recurring transactions.' };
    },
  );

  addTool(
    server,
    {
      name: 'update_recurring_merchant',
      title: 'Update recurring merchant',
      description:
        'Correct the recurring schedule for the merchant on a transaction. This changes Monarch bill and subscription predictions, not the transaction or any payment.',
      inputSchema: z.object({
        transaction_id: z.string().min(1).describe('Any transaction from the merchant to correct'),
        is_recurring: z.boolean(),
        frequency: z.string().min(1).optional(),
        base_date: dateSchema.optional(),
        amount: z.number().optional(),
        is_active: z.boolean().optional(),
      }),
      hints: UPDATE,
    },
    async ({ transaction_id, is_recurring, frequency, base_date, amount, is_active }) => {
      const details = await session.read((client) => client.getTransactionDetails(transaction_id));
      const previous = recurringValues(details);
      const requested = {
        merchantId: previous.merchantId,
        name: previous.name,
        isRecurring: is_recurring,
        ...(frequency ? { frequency } : {}),
        ...(base_date ? { baseDate: base_date } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(is_active !== undefined ? { isActive: is_active } : {}),
      };
      const prepared = changes.prepare({
        tool: 'update_recurring_merchant',
        affected_count: 1,
        reversible: true,
        undo: [
          {
            operation: 'update_recurring_merchant',
            transactionId: transaction_id,
            values: previous,
          },
        ],
        redo: [
          {
            operation: 'update_recurring_merchant',
            transactionId: transaction_id,
            values: requested,
          },
        ],
      });
      const { result, writeError, verified, guard } = await observeMutationOutcome(
        () => session.write((client) => client.updateRecurringMerchant(requested)),
        async () => {
          const after = await session.read((client) =>
            client.getTransactionDetails(transaction_id),
          );
          return {
            verified: recurringMatches(after, requested),
            guard: {
              kind: 'recurring' as const,
              transactionId: transaction_id,
              values: recurringValues(after),
            },
          };
        },
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
          ? `Updated and verified the recurring schedule for ${previous.name}; undo with ${change.id}.`
          : `The recurring update could not be verified; restore the prior schedule with ${change.id}.`,
        ambiguous: !verified,
        change: { id: change.id, affectedCount: 1, reversible: true },
      };
    },
  );
}
