import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { compactAccount } from '../projections.js';
import type { MonarchAccess } from '../session.js';
import { CREATE, READ_ONLY, REMOVE, UPDATE, addTool, detailSchema } from '../tool.js';

const date = z.iso.date().describe('Date in YYYY-MM-DD format');
const accountId = z.string().min(1).describe('Monarch account ID from get_accounts');

export function registerAccountTools(server: McpServer, session: MonarchAccess): void {
  addTool(
    server,
    {
      name: 'get_accounts',
      title: 'List Monarch accounts',
      description:
        'List bank, credit, investment, loan, and manual accounts. Compact output always includes account IDs, balances, institutions, and freshness.',
      inputSchema: z.object({ detail: detailSchema }),
      hints: READ_ONLY,
    },
    async ({ detail }) => {
      const response = await session.read((client) => client.getAccounts());
      const accounts =
        detail === 'full' ? response.accounts : response.accounts.map(compactAccount);
      return {
        data: { accounts, household_preferences: response.householdPreferences },
        summary: `Found ${accounts.length} Monarch accounts.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'get_account_holdings',
      title: 'Get account holdings',
      description: 'Get securities and positions for one investment account.',
      inputSchema: z.object({ account_id: accountId }),
      hints: READ_ONLY,
    },
    async ({ account_id }) => {
      const data = await session.read((client) => client.getAccountHoldings(account_id));
      return { data, summary: `Retrieved holdings for account ${account_id}.` };
    },
  );

  addTool(
    server,
    {
      name: 'get_account_history',
      title: 'Get account balance history',
      description: 'Get the complete available daily balance history for one account.',
      inputSchema: z.object({ account_id: accountId }),
      hints: READ_ONLY,
    },
    async ({ account_id }) => {
      const history = await session.read((client) => client.getAccountHistory(account_id));
      return {
        data: { account_id, history },
        summary: `Retrieved ${history.length} balance snapshots for account ${account_id}.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'get_recent_account_balances',
      title: 'Get recent account balances',
      description: 'Get daily balance arrays for every account starting on a date.',
      inputSchema: z.object({ start_date: date.optional() }),
      hints: READ_ONLY,
    },
    async ({ start_date }) => {
      const data = await session.read((client) => client.getRecentAccountBalances(start_date));
      return { data, summary: `Retrieved recent balances for ${data.accounts.length} accounts.` };
    },
  );

  addTool(
    server,
    {
      name: 'get_net_worth_history',
      title: 'Get net worth history',
      description:
        'Get daily aggregate balances across accounts, optionally filtered by account type.',
      inputSchema: z.object({
        start_date: date.optional(),
        end_date: date.optional(),
        account_type: z.string().min(1).optional(),
      }),
      hints: READ_ONLY,
    },
    async ({ start_date, end_date, account_type }) => {
      const data = await session.read((client) =>
        client.getAggregateSnapshots({
          ...(start_date ? { startDate: start_date } : {}),
          ...(end_date ? { endDate: end_date } : {}),
          ...(account_type ? { accountType: account_type } : {}),
        }),
      );
      return {
        data,
        summary: `Retrieved ${data.aggregateSnapshots.length} net worth snapshots.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'get_account_snapshots_by_type',
      title: 'Get balances by account type',
      description: 'Get monthly or yearly balance snapshots grouped by account type.',
      inputSchema: z.object({
        start_date: date,
        timeframe: z.enum(['month', 'year']),
      }),
      hints: READ_ONLY,
    },
    async ({ start_date, timeframe }) => {
      const data = await session.read((client) =>
        client.getAccountSnapshotsByType(start_date, timeframe),
      );
      return {
        data,
        summary: `Retrieved ${data.snapshotsByAccountType.length} account-type snapshots.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'get_account_type_options',
      title: 'Get account type options',
      description: 'List valid Monarch account types and subtypes for manual-account operations.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const data = await session.read((client) => client.getAccountTypeOptions());
      return { data, summary: 'Retrieved Monarch account type options.' };
    },
  );

  addTool(
    server,
    {
      name: 'get_institutions',
      title: 'Get linked institutions',
      description: 'List linked institutions, credentials, accounts, and connection state.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const data = await session.read((client) => client.getInstitutions());
      return { data, summary: 'Retrieved linked Monarch institutions and connection state.' };
    },
  );

  addTool(
    server,
    {
      name: 'get_subscription',
      title: 'Get Monarch subscription',
      description: 'Get the Monarch plan, entitlement, trial, and payment-source metadata.',
      inputSchema: z.object({}),
      hints: READ_ONLY,
    },
    async () => {
      const data = await session.read((client) => client.getSubscriptionDetails());
      return { data, summary: 'Retrieved Monarch subscription details.' };
    },
  );

  addTool(
    server,
    {
      name: 'get_refresh_status',
      title: 'Check account refresh status',
      description: 'Check whether a prior institution refresh has completed.',
      inputSchema: z.object({ account_ids: z.array(accountId).min(1).optional() }),
      hints: READ_ONLY,
    },
    async ({ account_ids }) => {
      const complete = await session.read((client) =>
        client.isAccountsRefreshComplete(account_ids),
      );
      return {
        data: { complete, account_ids: account_ids ?? null },
        summary: complete ? 'Account refresh is complete.' : 'Account refresh is still running.',
      };
    },
  );

  addTool(
    server,
    {
      name: 'refresh_accounts',
      title: 'Refresh linked accounts',
      description:
        'Ask linked institutions for current balances and transactions, wait for completion by default, then return fresh account metadata. Omit account_ids to refresh every account.',
      inputSchema: z.object({
        account_ids: z.array(accountId).min(1).optional(),
        wait: z.boolean().default(true),
        timeout_seconds: z.number().int().min(10).max(600).default(300),
        poll_seconds: z.number().int().min(1).max(30).default(5),
      }),
      hints: UPDATE,
    },
    async ({ account_ids, wait, timeout_seconds, poll_seconds }) => {
      const before = await session.read((client) => client.getAccounts());
      const ids = account_ids ?? before.accounts.map((account) => account.id);
      const startedAt = Date.now();
      const progress: Array<{ completed: number; total: number; elapsed_ms: number }> = [];

      let complete = false;
      if (wait) {
        complete = await session.write((client) =>
          client.requestAccountsRefreshAndWait({
            accountIds: ids,
            timeout: timeout_seconds,
            delay: poll_seconds,
            onProgress: (state) =>
              progress.push({
                completed: state.completed,
                total: state.total,
                elapsed_ms: state.elapsedMs,
              }),
          }),
        );
      } else {
        await session.write((client) => client.requestAccountsRefresh(ids));
      }

      const after = await session.read((client) => client.getAccounts());
      return {
        data: {
          complete: wait ? complete : null,
          account_ids: ids,
          elapsed_ms: Date.now() - startedAt,
          progress,
          accounts: after.accounts
            .filter((account) => ids.includes(account.id))
            .map(compactAccount),
        },
        summary: wait
          ? complete
            ? `Refreshed ${ids.length} accounts and observed completion.`
            : `Refresh did not complete within ${timeout_seconds} seconds.`
          : `Started refresh for ${ids.length} accounts.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'create_manual_account',
      title: 'Create manual account',
      description: 'Create a manual Monarch account.',
      inputSchema: z.object({
        name: z.string().min(1),
        account_type: z.string().min(1),
        account_subtype: z.string().min(1),
        balance: z.number().default(0),
        include_in_net_worth: z.boolean().default(true),
      }),
      hints: CREATE,
    },
    async ({ name, account_type, account_subtype, balance, include_in_net_worth }) => {
      const data = await session.write((client) =>
        client.createManualAccount({
          accountName: name,
          accountType: account_type,
          accountSubType: account_subtype,
          accountBalance: balance,
          isInNetWorth: include_in_net_worth,
        }),
      );
      return { data, summary: `Created manual account "${name}".` };
    },
  );

  addTool(
    server,
    {
      name: 'update_account',
      title: 'Update account',
      description: 'Update the supplied fields on an existing Monarch account.',
      inputSchema: z.object({
        account_id: accountId,
        name: z.string().min(1).optional(),
        balance: z.number().optional(),
        account_type: z.string().min(1).optional(),
        account_subtype: z.string().min(1).optional(),
        include_in_net_worth: z.boolean().optional(),
        hide_from_summary: z.boolean().optional(),
        hide_transactions_from_reports: z.boolean().optional(),
      }),
      hints: UPDATE,
    },
    async ({ account_id, ...updates }) => {
      if (Object.values(updates).every((value) => value === undefined)) {
        throw new Error('At least one account field must be supplied');
      }
      const data = await session.write((client) =>
        client.updateAccount(account_id, {
          ...(updates.name !== undefined ? { accountName: updates.name } : {}),
          ...(updates.balance !== undefined ? { accountBalance: updates.balance } : {}),
          ...(updates.account_type !== undefined ? { accountType: updates.account_type } : {}),
          ...(updates.account_subtype !== undefined
            ? { accountSubType: updates.account_subtype }
            : {}),
          ...(updates.include_in_net_worth !== undefined
            ? { includeInNetWorth: updates.include_in_net_worth }
            : {}),
          ...(updates.hide_from_summary !== undefined
            ? { hideFromSummaryList: updates.hide_from_summary }
            : {}),
          ...(updates.hide_transactions_from_reports !== undefined
            ? { hideTransactionsFromReports: updates.hide_transactions_from_reports }
            : {}),
        }),
      );
      return { data, summary: `Updated account ${account_id}.` };
    },
  );

  addTool(
    server,
    {
      name: 'delete_account',
      title: 'Delete account',
      description: 'Delete a Monarch account by ID.',
      inputSchema: z.object({ account_id: accountId }),
      hints: REMOVE,
    },
    async ({ account_id }) => {
      const data = await session.write((client) => client.deleteAccount(account_id));
      return { data, summary: `Deleted account ${account_id}.` };
    },
  );
}
