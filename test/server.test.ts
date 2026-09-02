import assert from 'node:assert/strict';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createServer } from '../src/server.js';
import type { MonarchAccess, MonarchClient } from '../src/session.js';

const account = {
  id: 'account-123',
  displayName: 'Checking',
  mask: '1234',
  currentBalance: 2500,
  displayBalance: 2500,
  type: { name: 'depository', display: 'Depository' },
  subtype: { name: 'checking', display: 'Checking' },
  institution: { id: 'institution-1', name: 'Bank' },
  credential: {
    id: 'credential-1',
    updateRequired: false,
    institution: { status: 'healthy' },
  },
  displayLastUpdatedAt: '2026-09-01T12:00:00Z',
  includeInNetWorth: true,
  isHidden: false,
  hideFromList: false,
  isManual: false,
};

const transaction = {
  id: 'transaction-123',
  date: '2026-09-01',
  amount: -42.5,
  merchant: { id: 'merchant-1', name: 'Store' },
  category: { id: 'category-1', name: 'Shopping' },
  account: { id: 'account-123', displayName: 'Checking' },
  notes: 'example',
  pending: false,
  needsReview: false,
  reviewStatus: 'reviewed',
  hideFromReports: false,
  isRecurring: false,
  isSplitTransaction: false,
  tags: [{ id: 'tag-1', name: 'Home' }],
};

const fakeClient = {
  getAccounts: async () => ({ accounts: [account], householdPreferences: { id: 'household-1' } }),
  getTransactions: async () => ({
    allTransactions: { totalCount: 101, results: [transaction] },
    transactionRules: [],
  }),
} as unknown as MonarchClient;

const access: MonarchAccess = {
  read: async (operation) => operation(fakeClient),
  write: async (operation) => operation(fakeClient),
};

async function withClient(callback: (client: Client) => Promise<void>): Promise<void> {
  const handler = createMcpHandler(() => createServer(access));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: 'monarch-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  try {
    await callback(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('advertises a complete, accurately annotated tool surface over modern MCP', async () => {
  await withClient(async (client) => {
    assert.equal(client.getProtocolEra(), 'modern');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 33);

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('get_accounts')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('refresh_accounts')?.annotations?.readOnlyHint, false);
    assert.equal(byName.get('delete_account')?.annotations?.destructiveHint, true);
    assert.ok(byName.get('get_transactions')?.outputSchema);
  });
});

test('compact account results retain the account ID and freshness fields', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'get_accounts',
      arguments: { detail: 'compact' },
    });
    assert.equal(result.isError, undefined);
    const output = result.structuredContent as {
      data: { accounts: Array<Record<string, unknown>> };
    };
    assert.equal(output.data.accounts[0]?.id, 'account-123');
    assert.equal(output.data.accounts[0]?.last_updated_at, '2026-09-01T12:00:00Z');
  });
});

test('transaction pagination is explicit and compact results retain relational IDs', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'get_transactions',
      arguments: { limit: 25, offset: 50, detail: 'compact' },
    });
    const output = result.structuredContent as {
      data: { transactions: Array<Record<string, unknown>> };
      meta: { page: { next_offset: number } };
    };
    assert.equal(output.data.transactions[0]?.id, 'transaction-123');
    assert.deepEqual(output.data.transactions[0]?.account, {
      id: 'account-123',
      name: 'Checking',
    });
    assert.deepEqual(output.data.transactions[0]?.category, {
      id: 'category-1',
      name: 'Shopping',
    });
    assert.equal(output.meta.page.next_offset, 51);
  });
});
