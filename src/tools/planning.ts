import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { MonarchAccess } from '../session.js';
import { READ_ONLY, UPDATE, addTool, assertDateRange, dateSchema, invalidInput } from '../tool.js';

const rangeSchema = z.object({
  start_date: dateSchema.optional(),
  end_date: dateSchema.optional(),
});

export function registerPlanningTools(server: McpServer, session: MonarchAccess): void {
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
      const data = await session.write((client) =>
        client.setBudgetAmount({
          amount,
          ...(category_id ? { categoryId: category_id } : {}),
          ...(category_group_id ? { categoryGroupId: category_group_id } : {}),
          ...(start_date ? { startDate: start_date } : {}),
          applyToFuture: apply_to_future,
        }),
      );
      return { data, summary: `Set budget amount to ${amount}.` };
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
}
