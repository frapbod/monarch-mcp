import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, InMemoryTransport, type Progress } from '@modelcontextprotocol/client';

import { FileChangeStore } from '../src/changes.js';
import { createServer } from '../src/server.js';
import type { MonarchAccess, MonarchClient } from '../src/session.js';

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
  type: { name: 'depository', display: 'Depository' },
  subtype: { name: 'checking', display: 'Checking' },
  institution: null,
  credential: null,
};

async function withClient(
  monarch: MonarchClient,
  callback: (client: Client, changes: FileChangeStore) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-progress-'));
  const changes = new FileChangeStore(directory);
  const access: MonarchAccess = {
    read: async (operation) => operation(monarch),
    write: async (operation) => operation(monarch),
  };
  const server = createServer(access, changes);
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

test('account refresh reports upstream progress', async () => {
  const client = {
    getAccounts: async () => ({ accounts: [account], householdPreferences: {} }),
    requestAccountsRefreshAndWait: async (options: {
      onProgress: (state: { completed: number; total: number; elapsedMs: number }) => void;
    }) => {
      options.onProgress({ completed: 1, total: 2, elapsedMs: 10 });
      options.onProgress({ completed: 2, total: 2, elapsedMs: 20 });
      return true;
    },
  } as unknown as MonarchClient;

  await withClient(client, async (mcp) => {
    const progress: number[] = [];
    const result = await mcp.callTool(
      { name: 'refresh_accounts', arguments: { wait: true } },
      { onprogress: ({ progress: value }) => progress.push(value) },
    );
    assert.notEqual(result.isError, true);
    assert.deepEqual(progress, [1, 2]);
  });
});

test('cancelling refresh polling stops the wait after the in-flight refresh request', async () => {
  let accountReads = 0;
  const client = {
    getAccounts: async () => {
      accountReads += 1;
      return { accounts: [account], householdPreferences: {} };
    },
    requestAccountsRefreshAndWait: async (options: {
      onProgress: (state: { completed: number; total: number; elapsedMs: number }) => void;
    }) => {
      options.onProgress({ completed: 0, total: 1, elapsedMs: 0 });
      await delay(25);
      options.onProgress({ completed: 0, total: 1, elapsedMs: 25 });
      return false;
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
      const change = changes.record({
        tool: 'bulk_update_transactions',
        affected_count: 8,
        reversible: true,
        undo: Array.from({ length: 8 }, (_, index) => ({
          operation: 'update_transaction' as const,
          id: `transaction-${index}`,
          values: { merchantName: 'Old merchant' },
        })),
      });
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
      assert.equal(event.change_id, change.id);
      assert.equal(event.affected_count, 4);
    });
  } finally {
    if (previousEventLog === undefined) delete process.env.MONARCH_MCP_EVENT_LOG;
    else process.env.MONARCH_MCP_EVENT_LOG = previousEventLog;
    rmSync(eventDirectory, { recursive: true, force: true });
  }
});
