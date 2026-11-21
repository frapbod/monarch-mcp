import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, InMemoryTransport, type Progress } from '@modelcontextprotocol/client';

import { RequestFailedException } from '@hakimelek/monarchmoney';

import { FileChangeStore } from '../src/changes.js';
import { createServer } from '../src/server.js';
import { MonarchSession, type MonarchAccess, type MonarchClient } from '../src/session.js';

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function transaction(id: string, merchantName = 'Old merchant') {
  return {
    id,
    amount: -10,
    date: '2026-09-01',
    notes: '',
    hideFromReports: false,
    needsReview: true,
    plaidName: merchantName,
    merchant: { id: `merchant-${id}`, name: merchantName },
    category: { id: 'category-1', name: 'Old category' },
    account: { id: 'account-1', displayName: 'Checking' },
    goal: null,
    tags: [],
    splitTransactions: [],
  };
}

const account = {
  id: 'account-1',
  displayName: 'Checking',
  currentBalance: 10,
  displayBalance: 10,
  displayLastUpdatedAt: '2026-09-01T12:00:00Z',
  type: { name: 'depository', display: 'Depository' },
  subtype: { name: 'checking', display: 'Checking' },
  institution: null,
  credential: null,
};

async function withClient(
  monarch: MonarchClient,
  callback: (client: Client, changes: FileChangeStore) => Promise<void>,
  accessOverride?: MonarchAccess,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-progress-'));
  const changes = new FileChangeStore(directory);
  const access: MonarchAccess = {
    read: async (operation) => operation(monarch),
    write: async (operation) => operation(monarch),
  };
  const server = createServer(accessOverride ?? access, changes);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'progress-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await callback(client, changes);
  } finally {
    await client.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('bulk updates report monotonic MCP progress through preparation and writes', async () => {
  const transactions = new Map(
    ['transaction-1', 'transaction-2', 'transaction-3'].map((id) => [id, transaction(id)]),
  );
  const client = {
    getTransactionDetails: async (id: string) => ({
      transaction: structuredClone(transactions.get(id)),
    }),
    updateTransaction: async (id: string, values: { merchantName?: string }) => {
      const current = transactions.get(id);
      if (current && values.merchantName) current.merchant.name = values.merchantName;
      return { updateTransaction: { transaction: { id }, errors: [] } };
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const progress: Progress[] = [];
    const result = await mcp.callTool(
      {
        name: 'bulk_update_transactions',
        arguments: {
          updates: [...transactions.keys()].map((transaction_id) => ({
            transaction_id,
            merchant_name: 'New merchant',
          })),
        },
      },
      { onprogress: (value) => progress.push(value) },
    );

    assert.notEqual(result.isError, true);
    assert.deepEqual(
      progress.map(({ progress: value }) => value),
      [1, 2, 3, 4, 5, 6],
    );
    assert.ok(progress.every(({ total }) => total === 6));
  });
});

test('rule previews report completion rather than an unfinished mutation total', async () => {
  const client = {
    getAllTransactions: async () => [transaction('transaction-1')],
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const progress: Progress[] = [];
    const result = await mcp.callTool(
      {
        name: 'preview_transaction_rule',
        arguments: { merchant_name_criteria: [{ operator: 'contains', value: 'merchant' }] },
      },
      { onprogress: (value) => progress.push(value) },
    );
    assert.notEqual(result.isError, true);
    assert.deepEqual(progress, [
      { progress: 1, total: 1, message: 'Found 1 matching transactions' },
    ]);
  });
});

test('retroactive rules report every snapshot, write, verification, and journal stage', async () => {
  const existing = transaction('transaction-1');
  const client = {
    getAllTransactions: async () => [existing],
    getTransactionDetails: async () => ({ transaction: structuredClone(existing) }),
    createTransactionRule: async () => {
      existing.category = { id: 'category-2', name: 'New category' };
      return { id: 'rule-1', order: 1, recentApplicationCount: 1 };
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const progress: Progress[] = [];
    const result = await mcp.callTool(
      {
        name: 'create_transaction_rule',
        arguments: {
          merchant_name_criteria: [{ operator: 'contains', value: 'merchant' }],
          set_category_action: 'category-2',
          apply_to_existing_transactions: true,
        },
      },
      { onprogress: (value) => progress.push(value) },
    );
    assert.notEqual(result.isError, true);
    assert.deepEqual(
      progress.map(({ progress: value }) => value),
      [1, 2, 3, 4, 5],
    );
    assert.ok(progress.every(({ total }) => total === 5));
  });
});

type Operation = {
  id: string;
  state: string;
  completedAccountCount: number;
  totalAccountCount: number;
  accounts: Array<{ accountId: string; state: string; timedOut: boolean; errorMessage: null }>;
};

function operation(state: string, completed: number, total = 2): Operation {
  return {
    id: 'operation-1',
    state,
    completedAccountCount: completed,
    totalAccountCount: total,
    accounts: Array.from({ length: total }, (_, index) => ({
      accountId: `account-${index + 1}`,
      state: index < completed ? 'COMPLETED' : 'REQUESTING_DATA',
      timedOut: false,
      errorMessage: null,
    })),
  };
}

// Fake of the client's GraphQL path, keyed by Monarch operation name.
function gqlCall(handlers: Record<string, (variables: Record<string, unknown>) => unknown>) {
  const calls: string[] = [];
  const call = async (name: string, _query: string, variables: Record<string, unknown> = {}) => {
    calls.push(name);
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected GraphQL operation ${name}`);
    return handler(variables);
  };
  return { call, calls };
}

const refreshAllAccepted = () => ({
  forceRefreshAllAccounts: { success: true, forceRefreshOperationId: 'operation-1', errors: null },
});

test('refresh of all accounts sends one Monarch request and waits for its operation', async () => {
  let reads = 0;
  const states = [
    operation('IN_PROGRESS', 0),
    operation('IN_PROGRESS', 1),
    operation('COMPLETED', 2),
  ];
  const gql = gqlCall({
    Common_ForceRefreshAccountsMutation: (variables) => {
      assert.deepEqual(variables, { input: {} });
      return refreshAllAccepted();
    },
    Common_ForceRefreshOperationQuery: (variables) => {
      assert.equal(variables.id, 'operation-1');
      return { forceRefreshOperation: states.shift() };
    },
  });
  const client = {
    gqlCall: gql.call,
    getAccounts: async () => ({
      accounts: [
        { ...account, canUseAvailableBalance: true, availableBalance: ++reads === 1 ? 20 : 7 },
      ],
      householdPreferences: {},
    }),
    requestAccountRefresh: async () => {
      throw new Error('refresh of all accounts must not send per-account requests');
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const progress: number[] = [];
    const result = await mcp.callTool(
      { name: 'refresh_accounts', arguments: { wait: true, poll_seconds: 1 } },
      { onprogress: ({ progress: value }) => progress.push(value) },
    );
    assert.notEqual(result.isError, true);
    assert.deepEqual(progress, [1, 2]);
    assert.deepEqual(gql.calls, [
      'Common_ForceRefreshAccountsMutation',
      'Common_ForceRefreshOperationQuery',
      'Common_ForceRefreshOperationQuery',
      'Common_ForceRefreshOperationQuery',
    ]);
    const { data } = result.structuredContent as {
      data: {
        complete: boolean;
        refused: unknown[];
        requested_account_ids: string[];
        refresh_operation: { operation_id: string; account_states: Record<string, number> };
        accounts: Array<Record<string, unknown>>;
      };
    };
    assert.equal(data.complete, true);
    assert.deepEqual(data.refused, []);
    assert.deepEqual(data.requested_account_ids, ['account-1', 'account-2']);
    assert.equal(data.refresh_operation.operation_id, 'operation-1');
    assert.deepEqual(data.refresh_operation.account_states, { COMPLETED: 2 });
    assert.equal(reads, 2);
    assert.equal(data.accounts[0]?.available_balance_supported, true);
    assert.equal(data.accounts[0]?.available_balance, 7);
  });
});

test('a refused refresh of all accounts reports the refusal and the latest operation', async () => {
  const gql = gqlCall({
    Common_ForceRefreshAccountsMutation: () => {
      throw new RequestFailedException('Please try again later: TOO_MANY_REQUESTS', {
        graphQLErrors: [
          {
            message: 'Please try again later: TOO_MANY_REQUESTS',
            extensions: { code: 'TOO_MANY_REQUESTS' },
          } as { message: string },
        ],
      });
    },
    Common_LatestForceRefreshOperation: () => ({
      latestForceRefreshOperation: { id: 'operation-1', state: 'COMPLETED' },
    }),
    Common_ForceRefreshOperationQuery: () => ({ forceRefreshOperation: operation('COMPLETED', 2) }),
  });
  const client = {
    gqlCall: gql.call,
    getAccounts: async () => ({ accounts: [account], householdPreferences: {} }),
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const result = await mcp.callTool({ name: 'refresh_accounts', arguments: {} });
    assert.notEqual(result.isError, true);
    const { data } = result.structuredContent as {
      data: {
        complete: null;
        refused: Array<{ account_id: null; code: string }>;
        requested_account_ids: string[];
        refresh_operation: { operation_id: string; complete: boolean };
      };
    };
    assert.equal(data.complete, null);
    assert.deepEqual(
      data.refused.map(({ account_id, code }) => ({ account_id, code })),
      [{ account_id: null, code: 'TOO_MANY_REQUESTS' }],
    );
    assert.deepEqual(data.requested_account_ids, []);
    assert.deepEqual(
      [data.refresh_operation.operation_id, data.refresh_operation.complete],
      ['operation-1', true],
    );
    assert.match(JSON.stringify(result.content), /refused a new refresh of all accounts/);
  });
});

test('a refresh-all refused in its payload with no operation waits on the household sync flag', async () => {
  const syncing = [true, true, false];
  const gql = gqlCall({
    // The form Monarch returned live: an error payload, not a GraphQL error.
    Common_ForceRefreshAccountsMutation: () => ({
      forceRefreshAllAccounts: {
        success: false,
        forceRefreshOperationId: null,
        errors: {
          fieldErrors: [],
          message: 'A force refresh has been recently performed. Please try again later.',
          code: 'TOO_MANY_REQUESTS',
        },
      },
    }),
    Common_LatestForceRefreshOperation: () => ({ latestForceRefreshOperation: null }),
    Common_ForceRefreshAccountsQuery: () => ({ hasAccountsSyncing: syncing.shift() }),
  });
  const client = {
    gqlCall: gql.call,
    getAccounts: async () => ({ accounts: [account], householdPreferences: {} }),
    waitForAccountsRefresh: async () => {
      throw new Error('refresh of all accounts must not wait on per-account sync flags');
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const result = await mcp.callTool({
      name: 'refresh_accounts',
      arguments: { wait: true, poll_seconds: 1 },
    });
    assert.notEqual(result.isError, true);
    const { data } = result.structuredContent as {
      data: {
        complete: boolean;
        refused: Array<{ account_id: null; code: string }>;
        refresh_operation: null;
        accounts_syncing: boolean;
      };
    };
    assert.deepEqual(
      data.refused.map(({ account_id, code }) => ({ account_id, code })),
      [{ account_id: null, code: 'TOO_MANY_REQUESTS' }],
    );
    assert.equal(data.refresh_operation, null);
    assert.equal(data.complete, true);
    assert.equal(data.accounts_syncing, false);
    assert.deepEqual(gql.calls, [
      'Common_ForceRefreshAccountsMutation',
      'Common_LatestForceRefreshOperation',
      'Common_ForceRefreshAccountsQuery',
      'Common_ForceRefreshAccountsQuery',
      'Common_ForceRefreshAccountsQuery',
    ]);
    assert.match(JSON.stringify(result.content), /reports no accounts syncing/);
  });
});

test('per-account refusals are listed while accepted requests still count', async () => {
  const second = { ...account, id: 'account-2' };
  const requested: string[] = [];
  const client = {
    getAccounts: async () => ({ accounts: [account, second], householdPreferences: {} }),
    requestAccountRefresh: async (id: string) => {
      if (id === 'account-2') {
        throw new RequestFailedException('Please try again later: TOO_MANY_REQUESTS', {
          graphQLErrors: [
            { message: 'TOO_MANY_REQUESTS', extensions: { code: 'TOO_MANY_REQUESTS' } } as {
              message: string;
            },
          ],
        });
      }
      requested.push(id);
      return true;
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const result = await mcp.callTool({
      name: 'refresh_accounts',
      arguments: { account_ids: ['account-1', 'account-2'] },
    });
    assert.notEqual(result.isError, true);
    const { data } = result.structuredContent as {
      data: {
        requested_account_ids: string[];
        refused: Array<{ account_id: string; code: string }>;
      };
    };
    assert.deepEqual(requested, ['account-1']);
    assert.deepEqual(data.requested_account_ids, ['account-1']);
    assert.deepEqual(
      data.refused.map(({ account_id, code }) => ({ account_id, code })),
      [{ account_id: 'account-2', code: 'TOO_MANY_REQUESTS' }],
    );
    assert.match(JSON.stringify(result.content), /Monarch refused 1 \(TOO_MANY_REQUESTS\)/);
  });
});

test('a refresh request with an unknown outcome is an error, not a refusal', async () => {
  const client = {
    getAccounts: async () => ({ accounts: [account], householdPreferences: {} }),
    requestAccountRefresh: async () => {
      throw new RequestFailedException('HTTP 502: Bad Gateway', { statusCode: 502 });
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const result = await mcp.callTool({
      name: 'refresh_accounts',
      arguments: { account_ids: ['account-1'] },
    });
    assert.equal(result.isError, true);
  });
});

test('refresh status without account IDs reports the latest or named operation', async () => {
  const gql = gqlCall({
    Common_LatestForceRefreshOperation: () => ({
      latestForceRefreshOperation: { id: 'operation-1', state: 'IN_PROGRESS' },
    }),
    Common_ForceRefreshOperationQuery: (variables) => ({
      forceRefreshOperation:
        variables.id === 'operation-1'
          ? operation('IN_PROGRESS', 1)
          : variables.id === 'operation-2'
            ? { ...operation('COMPLETED', 2), id: 'operation-2' }
            : null,
    }),
  });
  const client = {
    gqlCall: gql.call,
    isAccountsRefreshComplete: async () => {
      throw new Error('operation status must not use per-account sync flags');
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const latest = await mcp.callTool({ name: 'get_refresh_status', arguments: {} });
    const latestData = (latest.structuredContent as { data: Record<string, unknown> }).data;
    assert.equal(latestData.complete, false);
    assert.equal(
      (latestData.refresh_operation as { completed_accounts: number }).completed_accounts,
      1,
    );
    const named = await mcp.callTool({
      name: 'get_refresh_status',
      arguments: { operation_id: 'operation-2' },
    });
    assert.equal((named.structuredContent as { data: { complete: boolean } }).data.complete, true);
    const missing = await mcp.callTool({
      name: 'get_refresh_status',
      arguments: { operation_id: 'operation-3' },
    });
    assert.equal(missing.isError, true);
  });
});

test('refresh status with no operation answers from the household sync flag', async () => {
  let syncing = true;
  const gql = gqlCall({
    Common_LatestForceRefreshOperation: () => ({ latestForceRefreshOperation: null }),
    Common_ForceRefreshAccountsQuery: () => ({ hasAccountsSyncing: syncing }),
  });
  const client = {
    gqlCall: gql.call,
    isAccountsRefreshComplete: async () => {
      throw new Error('status without account IDs must not use per-account sync flags');
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const running = await mcp.callTool({ name: 'get_refresh_status', arguments: {} });
    assert.notEqual(running.isError, true);
    assert.deepEqual((running.structuredContent as { data: unknown }).data, {
      complete: false,
      account_ids: null,
      refresh_operation: null,
      completion_scope: 'monarch_sync',
      bank_freshness: 'unverified',
    });
    syncing = false;
    const idle = await mcp.callTool({ name: 'get_refresh_status', arguments: {} });
    assert.equal((idle.structuredContent as { data: { complete: boolean } }).data.complete, true);
    assert.match(JSON.stringify(idle.content), /reports no accounts syncing/);
  });
});

for (const complete of [true, false, null]) {
  test(`refresh completion ${complete} never verifies bank freshness or available cash`, async () => {
    const client = {
      getAccounts: async () => ({ accounts: [account], householdPreferences: {} }),
      requestAccountRefresh: async () => true,
      waitForAccountsRefresh: async () => {
        if (complete === null) throw new Error('the default call must not wait for the sync');
        return complete;
      },
      requestAccountsRefresh: async () => undefined,
      isAccountsRefreshComplete: async () => complete === true,
    } as unknown as MonarchClient;

    await withClient(client, async (mcp) => {
      const result = await mcp.callTool({
        name: 'refresh_accounts',
        arguments: { account_ids: ['account-1'], ...(complete === null ? {} : { wait: true }) },
      });
      assert.notEqual(result.isError, true);
      const { data } = result.structuredContent as {
        data: {
          complete: boolean | null;
          completion_scope: string;
          balance_context: Record<string, unknown>;
          accounts: Array<Record<string, unknown>>;
        };
      };
      assert.equal(data.complete, complete);
      assert.equal(data.completion_scope, 'monarch_sync');
      assert.equal(data.balance_context.bank_freshness, 'unverified');
      assert.equal(data.accounts[0]?.available_balance_supported, false);
      assert.equal(data.accounts[0]?.available_balance, null);
      assert.equal(data.balance_context.pending_transactions_included, 'unknown');
      assert.equal(data.accounts[0]?.current_balance, 10);
      assert.equal(data.accounts[0]?.monarch_last_updated_at, account.displayLastUpdatedAt);
      assert.match(JSON.stringify(result.content), /Bank freshness is not verified/);

      const status = await mcp.callTool({
        name: 'get_refresh_status',
        arguments: { account_ids: ['account-1'] },
      });
      assert.deepEqual((status.structuredContent as { data: unknown }).data, {
        complete: complete === true,
        account_ids: ['account-1'],
        completion_scope: 'monarch_sync',
        bank_freshness: 'unverified',
      });
    });
  });
}

test('cancelling refresh polling stops the wait after the in-flight refresh request', async () => {
  let accountReads = 0;
  const gql = gqlCall({
    Common_ForceRefreshAccountsMutation: refreshAllAccepted,
    Common_ForceRefreshOperationQuery: () => ({
      forceRefreshOperation: operation('IN_PROGRESS', 0),
    }),
  });
  const client = {
    gqlCall: gql.call,
    getAccounts: async () => {
      accountReads += 1;
      return { accounts: [account], householdPreferences: {} };
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const abort = new AbortController();
    const request = mcp.callTool(
      { name: 'refresh_accounts', arguments: { wait: true } },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 5);
    await assert.rejects(request, /AbortError/);
    await delay(50);
    assert.equal(accountReads, 1);
    assert.deepEqual(gql.calls, [
      'Common_ForceRefreshAccountsMutation',
      'Common_ForceRefreshOperationQuery',
    ]);
  });
});

test('cancelling bulk preparation prevents every mutation and journal entry', async () => {
  let writes = 0;
  const client = {
    getTransactionDetails: async (id: string) => {
      await delay(25);
      return { transaction: transaction(id) };
    },
    updateTransaction: async () => {
      writes += 1;
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp, changes) => {
    const abort = new AbortController();
    const request = mcp.callTool(
      {
        name: 'bulk_update_transactions',
        arguments: {
          updates: Array.from({ length: 12 }, (_, index) => ({
            transaction_id: `transaction-${index}`,
            merchant_name: 'New merchant',
          })),
        },
      },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 5);
    await assert.rejects(request, /AbortError/);
    await delay(50);
    assert.equal(writes, 0);
    assert.deepEqual(changes.list(20), []);
  });
});

test('cancelling bulk writes stops new writes and journals only attempted transactions', async () => {
  const transactions = new Map(
    Array.from({ length: 12 }, (_, index) => {
      const id = `transaction-${index}`;
      return [id, transaction(id)] as const;
    }),
  );
  let writes = 0;
  let mutationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  const client = {
    getTransactionDetails: async (id: string) => ({
      transaction: structuredClone(transactions.get(id)),
    }),
    updateTransaction: async (id: string, values: { merchantName?: string }) => {
      writes += 1;
      mutationStarted?.();
      const current = transactions.get(id);
      if (current && values.merchantName) current.merchant.name = values.merchantName;
      await delay(25);
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp, changes) => {
    const abort = new AbortController();
    const request = mcp.callTool(
      {
        name: 'bulk_update_transactions',
        arguments: {
          updates: [...transactions.keys()].map((transaction_id) => ({
            transaction_id,
            merchant_name: 'New merchant',
          })),
        },
      },
      { signal: abort.signal },
    );
    await started;
    abort.abort();
    await assert.rejects(request, /AbortError/);
    await delay(75);
    assert.equal(writes, 4);
    const [change] = changes.list(20);
    assert.equal(change?.status, 'active');
    assert.equal(change?.affected_count, 4);
    assert.equal(change?.undo.length, 4);
  });
});

test('cancelling retroactive rule snapshotting prevents rule creation', async () => {
  const transactions = Array.from({ length: 12 }, (_, index) =>
    transaction(`transaction-${index}`),
  );
  let creates = 0;
  const client = {
    getAllTransactions: async () => transactions,
    getTransactionDetails: async (id: string) => {
      await delay(25);
      return { transaction: transaction(id) };
    },
    createTransactionRule: async () => {
      creates += 1;
      return { id: 'rule-1', order: 1 };
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp, changes) => {
    const abort = new AbortController();
    const request = mcp.callTool(
      {
        name: 'create_transaction_rule',
        arguments: {
          merchant_name_criteria: [{ operator: 'contains', value: 'merchant' }],
          set_category_action: 'category-2',
          apply_to_existing_transactions: true,
        },
      },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 5);
    await assert.rejects(request, /AbortError/);
    await delay(50);
    assert.equal(creates, 0);
    assert.deepEqual(changes.list(20), []);
  });
});

test('cancelling after a retroactive rule write still completes its durable journal', async () => {
  const existing = transaction('transaction-1');
  let mutationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  const client = {
    getAllTransactions: async () => [existing],
    getTransactionDetails: async () => ({ transaction: structuredClone(existing) }),
    createTransactionRule: async () => {
      mutationStarted?.();
      await delay(25);
      existing.category = { id: 'category-2', name: 'New category' };
      return { id: 'rule-1', order: 1, recentApplicationCount: 1 };
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp, changes) => {
    const abort = new AbortController();
    const request = mcp.callTool(
      {
        name: 'create_transaction_rule',
        arguments: {
          merchant_name_criteria: [{ operator: 'contains', value: 'merchant' }],
          set_category_action: 'category-2',
          apply_to_existing_transactions: true,
        },
      },
      { signal: abort.signal },
    );
    await started;
    abort.abort();
    await assert.rejects(request, /AbortError/);
    await delay(75);
    const [change] = changes.list(20);
    assert.equal(change?.status, 'active');
    assert.equal(change?.reversible, true);
    assert.equal(change?.affected_count, 2);
    assert.equal(change?.undo.length, 2);
    assert.equal(change?.guards?.length, 2);
  });
});

test('cancelling an active undo stops new writes and marks partial work uncertain', async () => {
  const eventDirectory = mkdtempSync(join(tmpdir(), 'monarch-mcp-cancel-events-'));
  const eventLog = join(eventDirectory, 'events.jsonl');
  const previousEventLog = process.env.MONARCH_MCP_EVENT_LOG;
  process.env.MONARCH_MCP_EVENT_LOG = eventLog;
  let writes = 0;
  const client = {
    updateTransaction: async () => {
      writes += 1;
      await delay(25);
    },
  } as unknown as MonarchClient;
  try {
    await withClient(client, async (mcp, changes) => {
      const prepared = changes.prepare({
        tool: 'bulk_update_transactions',
        affected_count: 8,
        reversible: true,
        undo: Array.from({ length: 8 }, (_, index) => ({
          operation: 'update_transaction' as const,
          id: `transaction-${index}`,
          values: { merchantName: 'Old merchant' },
        })),
      });
      const change = changes.activate(prepared.id);
      const abort = new AbortController();
      const request = mcp.callTool(
        { name: 'undo_change', arguments: { change_id: change.id, force: true } },
        { signal: abort.signal },
      );
      setTimeout(() => abort.abort(), 5);
      await assert.rejects(request, /AbortError/);
      await delay(50);
      assert.equal(writes, 4);
      assert.equal(changes.get(change.id)?.status, 'uncertain');
      const event = JSON.parse(readFileSync(eventLog, 'utf8').trim()) as Record<string, unknown>;
      assert.equal(event.outcome, 'cancelled');
    });
  } finally {
    if (previousEventLog === undefined) delete process.env.MONARCH_MCP_EVENT_LOG;
    else process.env.MONARCH_MCP_EVENT_LOG = previousEventLog;
    rmSync(eventDirectory, { recursive: true, force: true });
  }
});

test('refresh authentication recovery never repeats accepted writes or resets the wait budget', async () => {
  let requests = 0;
  const budgets: number[] = [];
  const session = new MonarchSession(
    { email: 'test@example.com', password: 'test', sessionFile: '/unused', timeoutSeconds: 30 },
    () => {
      const client = {
        token: 'test-token',
        login: async () => undefined,
        getAccounts: async () => ({ accounts: [account], householdPreferences: {} }),
        requestAccountRefresh: async () => {
          requests += 1;
          return true;
        },
        requestAccountsRefresh: async () => {
          requests += 1;
          return true;
        },
        waitForAccountsRefresh: async (options: { timeout: number }) => {
          budgets.push(options.timeout);
          if (budgets.length === 1) {
            await delay(20);
            throw new RequestFailedException('expired during polling', { statusCode: 401 });
          }
          return true;
        },
        requestAccountsRefreshAndWait: async (options: { timeout: number }) => {
          await client.requestAccountsRefresh();
          return client.waitForAccountsRefresh(options);
        },
      };
      return client as unknown as MonarchClient;
    },
  );
  await withClient(
    {} as MonarchClient,
    async (mcp) => {
      const result = await mcp.callTool({
        name: 'refresh_accounts',
        arguments: { account_ids: [account.id], wait: true },
      });
      assert.notEqual(result.isError, true);
      assert.equal(
        requests,
        1,
        'an authentication error in a status read must not replay the refresh',
      );
      assert.equal(budgets.length, 2);
      assert.ok(budgets[1]! < budgets[0]!, 'reauthentication must use the remaining wait budget');
    },
    session,
  );
});

test('refresh waits for existing work without requesting an ineligible account again', async () => {
  let requests = 0;
  const client = {
    getAccounts: async () => ({
      accounts: [{ ...account, canBeForceRefreshed: false }],
      householdPreferences: {},
    }),
    requestAccountRefresh: async () => {
      requests += 1;
      return true;
    },
    requestAccountsRefreshAndWait: async () => {
      requests += 1;
      return false;
    },
    waitForAccountsRefresh: async () => false,
  } as unknown as MonarchClient;
  await withClient(client, async (mcp) => {
    const result = await mcp.callTool({
      name: 'refresh_accounts',
      arguments: { account_ids: [account.id], wait: true },
    });
    assert.notEqual(result.isError, true);
    assert.equal(requests, 0);
    assert.equal(
      (result.structuredContent as { data: { complete: boolean } }).data.complete,
      false,
    );
  });
});
