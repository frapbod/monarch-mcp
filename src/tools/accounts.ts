import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  type AccountValues,
  type ChangeStore,
  journalMutation,
  selectedValues,
} from '../changes.js';
import { compactAccount } from '../projections.js';
import type { MonarchAccess } from '../session.js';
import {
  ACTION,
  CREATE,
  READ_ONLY,
  REMOVE,
  UPDATE,
  addTool,
  dateSchema,
  detailSchema,
  invalidInput,
  reportProgress,
  throwIfCancelled,
} from '../tool.js';
import {
  compactOperation,
  getLatestRefreshOperationId,
  getRefreshOperation,
  refusalCode,
  requestRefreshAll,
} from '../refresh.js';

const accountId = z.string().min(1).describe('Monarch account ID from get_accounts');

const balanceContext = {
  source: 'monarch',
  pending_transactions_included: 'unknown',
  bank_freshness: 'unverified',
} as const;

const balanceNotice =
  "Monarch-reported balances. available_balance uses Monarch's available-balance preview when supported by the account, independent of its display setting; otherwise null. Bank freshness is not verified. Do not subtract pending transactions automatically.";

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

function operationSummary(operation: ReturnType<typeof compactOperation>): string {
  const states = Object.entries(operation.account_states)
    .map(([state, count]) => `${count} ${state.toLowerCase()}`)
    .join(', ');
  return `Monarch refresh operation ${operation.operation_id} is ${
    operation.complete ? 'complete' : 'still running'
  } (${operation.completed_accounts} of ${operation.total_accounts} accounts done${
    states ? `: ${states}` : ''
  }).`;
}

function refreshSummary(result: {
  all: boolean;
  wait: boolean;
  complete: boolean;
  timeoutSeconds: number;
  selected: number;
  requested: number;
  refused: ReadonlyArray<{ code: string; message: string }>;
  operation: ReturnType<typeof compactOperation> | null;
}): string {
  const refusedCodes = [...new Set(result.refused.map((item) => item.code))].join(', ');
  if (result.all) {
    const refusal = result.refused[0];
    const start = refusal
      ? `Monarch refused a new refresh of all accounts (${refusal.code}: ${refusal.message}); ${
          result.operation
            ? 'reporting its latest refresh operation instead.'
            : 'it reports no recent refresh operation.'
        }`
      : 'Requested a Monarch refresh of all accounts.';
    if (!result.operation) return start;
    const status = operationSummary(result.operation);
    if (!result.wait && !result.operation.complete) {
      return `${start} ${status} Poll get_refresh_status with operation_id ${result.operation.operation_id}, or pass wait=true.`;
    }
    if (result.wait && !result.complete) {
      return `${start} ${status} It did not complete within ${result.timeoutSeconds} seconds.`;
    }
    return `${start} ${status}`;
  }
  const refusedText = result.refused.length
    ? ` Monarch refused ${result.refused.length} (${refusedCodes}); see refused.`
    : '';
  return `${
    result.wait
      ? result.complete
        ? `Monarch reports sync complete for ${result.selected} accounts.`
        : `Refresh did not complete within ${result.timeoutSeconds} seconds.`
      : `Selected ${result.selected} accounts; did not wait for the sync, poll get_refresh_status.`
  } Requested ${result.requested} new refreshes; Monarch determines refresh eligibility.${refusedText}`;
}

export function registerAccountTools(
  server: McpServer,
  session: MonarchAccess,
  changes: ChangeStore,
): void {
  addTool(
    server,
    {
      name: 'get_accounts',
      title: 'List Monarch accounts',
      description: `List bank, credit, investment, loan, and manual accounts. Compact current_balance is Monarch currentBalance, not verified spendable cash. institution_status is institution-wide; monarch_last_updated_at is Monarch metadata. ${balanceNotice}`,
      inputSchema: z.object({ detail: detailSchema }),
      hints: READ_ONLY,
    },
    async ({ detail }) => {
      const response = await session.read((client) => client.getAccounts());
      const accounts =
        detail === 'full' ? response.accounts : response.accounts.map(compactAccount);
      return {
        data: {
          accounts,
          household_preferences: response.householdPreferences,
          balance_context: balanceContext,
        },
        summary: `Found ${accounts.length} Monarch accounts. ${balanceNotice}`,
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
      inputSchema: z.object({ start_date: dateSchema.optional() }),
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
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
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
        start_date: dateSchema,
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
      description:
        "Check whether Monarch reports a refresh complete. Without account_ids it reports Monarch's refresh operation (operation_id from refresh_accounts, or the latest one) with each account's state; with account_ids it reports whether those accounts still sync. Completion does not prove that the bank supplied newer data or that a balance is available to spend.",
      inputSchema: z.object({
        account_ids: z.array(accountId).min(1).optional(),
        operation_id: z
          .string()
          .min(1)
          .optional()
          .describe('Refresh operation ID returned by refresh_accounts'),
      }),
      hints: READ_ONLY,
    },
    async ({ account_ids, operation_id }) => {
      if (account_ids && operation_id) invalidInput('Pass account_ids or operation_id, not both');
      if (!account_ids) {
        const id =
          operation_id ?? (await session.read((client) => getLatestRefreshOperationId(client)));
        const operation = id
          ? await session.read((client) => getRefreshOperation(client, id))
          : null;
        if (operation_id && !operation)
          invalidInput('Monarch has no refresh operation with that ID');
        if (operation) {
          const view = compactOperation(operation);
          return {
            data: {
              complete: view.complete,
              account_ids: null,
              refresh_operation: view,
              completion_scope: 'monarch_sync',
              bank_freshness: 'unverified',
            },
            summary: `${operationSummary(view)} Bank freshness is not verified.`,
          };
        }
      }
      const complete = await session.read((client) =>
        client.isAccountsRefreshComplete(account_ids),
      );
      return {
        data: {
          complete,
          account_ids: account_ids ?? null,
          completion_scope: 'monarch_sync',
          bank_freshness: 'unverified',
        },
        summary: `${complete ? 'Monarch reports sync complete.' : 'Monarch sync is still running.'} Bank freshness is not verified.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'refresh_accounts',
      title: 'Refresh linked accounts',
      description: `Request a Monarch sync and return at once with complete=null; poll get_refresh_status until the sync is done, then read the accounts. Pass wait=true to block until the sync is done or timeout_seconds passes, then re-read the accounts. Omit account_ids to refresh every account the way Monarch's "Refresh all" does: one request, tracked by refresh_operation. account_ids sends one request per account, which Monarch often refuses with TOO_MANY_REQUESTS; refused requests are listed in refused, not raised as an error. complete only reports Monarch sync completion, not newer bank data. ${balanceNotice}`,
      inputSchema: z.object({
        account_ids: z.array(accountId).min(1).optional(),
        wait: z.boolean().default(false),
        timeout_seconds: z.number().int().min(10).max(600).default(300),
        poll_seconds: z.number().int().min(1).max(30).default(5),
      }),
      hints: ACTION,
    },
    async ({ account_ids, wait, timeout_seconds, poll_seconds }, context) => {
      throwIfCancelled(context);
      const cancelledMessage =
        'Account refresh polling was cancelled; the institution refresh may continue';
      const before = await session.read((client) => client.getAccounts());
      const ids = [...new Set(account_ids ?? before.accounts.map((account) => account.id))];
      const startedAt = performance.now();
      const deadline = startedAt + timeout_seconds * 1000;
      const requestedIds: string[] = [];
      const refused: Array<{ account_id: string | null; code: string; message: string }> = [];
      const progress: Array<{ completed: number; total: number; elapsed_ms: number }> = [];
      const notifications: Promise<void>[] = [];
      const onProgress = (completed: number, total: number, elapsedMs: number): void => {
        throwIfCancelled(context, cancelledMessage);
        progress.push({ completed, total, elapsed_ms: elapsedMs });
        notifications.push(
          reportProgress(
            context,
            completed,
            total,
            `Monarch reports sync complete for ${completed} of ${total} accounts`,
          ),
        );
      };

      let complete = false;
      let operation: ReturnType<typeof compactOperation> | null = null;
      if (!account_ids) {
        let operationId: string | null = null;
        try {
          operationId = await session.write((client) => requestRefreshAll(client));
        } catch (error) {
          const code = refusalCode(error);
          if (!code) throw error;
          refused.push({ account_id: null, code, message: (error as Error).message });
        }
        const trackedId =
          operationId ?? (await session.read((client) => getLatestRefreshOperationId(client)));
        const readOperation = () =>
          trackedId ? session.read((client) => getRefreshOperation(client, trackedId)) : null;
        let current = await readOperation();
        if (current && refused.length === 0) {
          requestedIds.push(...current.accounts.map((account) => account.accountId));
        }
        while (wait && current && current.state !== 'COMPLETED') {
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          await pause(Math.min(poll_seconds * 1000, remaining), context.mcpReq.signal);
          throwIfCancelled(context, cancelledMessage);
          current = await readOperation();
          if (current) {
            onProgress(
              current.completedAccountCount,
              current.totalAccountCount,
              Math.round(performance.now() - startedAt),
            );
          }
        }
        operation = current ? compactOperation(current) : null;
        complete = operation?.complete ?? false;
      } else {
        const selected = ids.map((id) => {
          const account = before.accounts.find((candidate) => candidate.id === id);
          if (!account) invalidInput('Selected account was not returned by Monarch');
          return account;
        });
        for (const account of selected) {
          if (account.canBeForceRefreshed === false) continue;
          throwIfCancelled(context);
          try {
            await session.write((client) => client.requestAccountRefresh(account.id));
            requestedIds.push(account.id);
          } catch (error) {
            const code = refusalCode(error);
            if (!code) throw error;
            refused.push({ account_id: account.id, code, message: (error as Error).message });
          }
        }
        if (wait) {
          complete = await session.read((client) =>
            client.waitForAccountsRefresh({
              accountIds: ids,
              timeout: Math.max(0, (deadline - performance.now()) / 1000),
              delay: poll_seconds,
              onProgress: (state) => onProgress(state.completed, state.total, state.elapsedMs),
            }),
          );
        }
      }

      await Promise.all(notifications);
      throwIfCancelled(context, cancelledMessage);
      const after = await session.read((client) => client.getAccounts());
      throwIfCancelled(context, cancelledMessage);
      return {
        data: {
          complete: wait ? complete : null,
          completion_scope: 'monarch_sync',
          balance_context: balanceContext,
          account_ids: ids,
          requested_account_ids: requestedIds,
          refused,
          refresh_operation: operation,
          elapsed_ms: Math.round(performance.now() - startedAt),
          progress,
          accounts: after.accounts
            .filter((account) => ids.includes(account.id))
            .map(compactAccount),
        },
        summary: `${refreshSummary({
          all: !account_ids,
          wait,
          complete,
          timeoutSeconds: timeout_seconds,
          selected: ids.length,
          requested: requestedIds.length,
          refused,
          operation,
        })} ${balanceNotice}`,
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
      const request = {
        accountName: name,
        accountType: account_type,
        accountSubType: account_subtype,
        accountBalance: balance,
        isInNetWorth: include_in_net_worth,
      };
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'create_manual_account',
          affected_count: 1,
          reversible: false,
          reversibility_reason: 'The created account ID is not known until Monarch responds.',
          undo: [],
          snapshot: { request },
        },
        () => session.write((client) => client.createManualAccount(request)),
        (result) => {
          const created = result.createManualAccount.account;
          if (!created) throw new Error(`Monarch did not create manual account "${name}"`);
          const createdValues: AccountValues = {
            accountName: name,
            accountBalance: balance,
            accountType: account_type,
            accountSubType: account_subtype,
            includeInNetWorth: include_in_net_worth,
            hideFromSummaryList: false,
            hideTransactionsFromReports: false,
          };
          return {
            reversible: true,
            reversibility_reason: null,
            undo: [{ operation: 'delete_account', id: created.id }],
            guards: [{ kind: 'account', id: created.id, values: createdValues }],
          };
        },
      );
      const created = data.createManualAccount.account;
      if (!created) throw new Error(`Monarch did not create manual account "${name}"`);
      return {
        data: { ...data, change_id: change.id },
        summary: `Created manual account "${name}"; undo with ${change.id}.`,
      };
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
        invalidInput('At least one account field must be supplied');
      }
      const before = (await session.read((client) => client.getAccounts())).accounts.find(
        ({ id }) => id === account_id,
      );
      if (!before) throw new Error(`Account ${account_id} was not found`);
      const current: AccountValues = {
        accountName: before.displayName,
        accountBalance: before.displayBalance,
        accountType: before.type.name,
        accountSubType: before.subtype.name,
        includeInNetWorth: before.includeInNetWorth,
        hideFromSummaryList: before.hideFromList,
        hideTransactionsFromReports: before.hideTransactionsFromReports,
      };
      const requested: AccountValues = {
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
      };
      const previous = selectedValues(current, requested);
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'update_account',
          affected_count: 1,
          reversible: true,
          undo: [{ operation: 'update_account', id: account_id, values: previous }],
        },
        () => session.write((client) => client.updateAccount(account_id, requested)),
        (result) => {
          if (!result.updateAccount.account)
            throw new Error(`Monarch did not update account ${account_id}`);
          return {
            guards: [{ kind: 'account', id: account_id, values: requested }],
          };
        },
      );
      return {
        data: { ...data, change_id: change.id },
        summary: `Updated account ${account_id}; undo with ${change.id}.`,
      };
    },
  );

  addTool(
    server,
    {
      name: 'upload_account_balance_history',
      title: 'Upload account balance history',
      description: 'Upload Monarch-format CSV balance history for one manual account.',
      inputSchema: z.object({
        account_id: accountId,
        csv_content: z
          .string()
          .min(1)
          .describe('CSV with unique, non-future dates and a Balance or Amount column'),
      }),
      hints: UPDATE,
    },
    async ({ account_id, csv_content }) => {
      const { change } = await journalMutation(
        changes,
        {
          tool: 'upload_account_balance_history',
          affected_count: 1,
          reversible: false,
          reversibility_reason:
            'Monarch does not expose an atomic restore for imported balance history.',
          undo: [],
        },
        () =>
          session.write((client) => client.uploadAccountBalanceHistory(account_id, csv_content)),
      );
      return {
        data: { account_id, uploaded: true, change_id: change.id },
        summary: `Uploaded balance history for account ${account_id}; recorded as ${change.id} (not automatically reversible).`,
      };
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
      const before = (await session.read((client) => client.getAccounts())).accounts.find(
        ({ id }) => id === account_id,
      );
      if (!before) throw new Error(`Account ${account_id} was not found`);
      const { value: data, change } = await journalMutation(
        changes,
        {
          tool: 'delete_account',
          affected_count: 1,
          reversible: false,
          reversibility_reason:
            'Recreating an account would not restore its original ID, links, transactions, or holdings.',
          undo: [],
          snapshot: before,
        },
        () => session.write((client) => client.deleteAccount(account_id)),
        (result) => {
          if (!result.deleteAccount.deleted)
            throw new Error(`Monarch did not delete account ${account_id}`);
          return {};
        },
      );
      return {
        data: { ...data, change_id: change.id },
        summary: `Deleted account ${account_id}; recorded as ${change.id} (not automatically reversible).`,
      };
    },
  );
}
