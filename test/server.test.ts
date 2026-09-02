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

const uploadedBalanceHistory: Array<{ accountId: string; csvContent: string }> = [];

const fakeClient = {
  getAccounts: async () => ({ accounts: [account], householdPreferences: { id: 'household-1' } }),
  getTransactionsSummary: async () => ({
    aggregates: [
      {
        summary: {
          avg: 42.5,
          count: 1,
          max: 42.5,
          maxExpense: 42.5,
          sum: 42.5,
          sumIncome: 0,
          sumExpense: 42.5,
          first: '2026-09-01',
          last: '2026-09-01',
        },
      },
    ],
  }),
  getTransactions: async () => ({
    allTransactions: { totalCount: 101, results: [transaction] },
    transactionRules: [],
  }),
  uploadAccountBalanceHistory: async (accountId: string, csvContent: string) => {
    uploadedBalanceHistory.push({ accountId, csvContent });
  },
} as unknown as MonarchClient;

const access: MonarchAccess = {
  read: async (operation) => operation(fakeClient),
  write: async (operation) => operation(fakeClient),
};

async function withClient(
  callback: (client: Client) => Promise<void>,
  mode: 'auto' | 'legacy' = 'auto',
): Promise<void> {
  const handler = createMcpHandler(() => createServer(access));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: 'monarch-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  try {
    await callback(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('serves the complete tool surface over legacy MCP', async () => {
  await withClient(async (client) => {
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal((await client.listTools()).tools.length, 35);
  }, 'legacy');
});

test('advertises a complete, accurately annotated tool surface over modern MCP', async () => {
  await withClient(async (client) => {
    assert.equal(client.getProtocolEra(), 'modern');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'create_manual_account',
      'create_transaction',
      'create_transaction_category',
      'create_transaction_tag',
      'delete_account',
      'delete_transaction',
      'delete_transaction_category',
      'get_account_history',
      'get_account_holdings',
      'get_account_snapshots_by_type',
      'get_account_type_options',
      'get_accounts',
      'get_budgets',
      'get_cashflow',
      'get_cashflow_summary',
      'get_institutions',
      'get_net_worth_history',
      'get_recent_account_balances',
      'get_recurring_transactions',
      'get_refresh_status',
      'get_subscription',
      'get_transaction',
      'get_transaction_categories',
      'get_transaction_category_groups',
      'get_transaction_splits',
      'get_transaction_tags',
      'get_transactions',
      'get_transactions_summary',
      'refresh_accounts',
      'set_budget_amount',
      'set_transaction_splits',
      'set_transaction_tags',
      'update_account',
      'update_transaction',
      'upload_account_balance_history',
    ]);

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

test('returns the upstream transaction summary without projection loss', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'get_transactions_summary', arguments: {} });
    const output = result.structuredContent as {
      data: { summary: { count: number; first: string } };
    };
    assert.equal(output.data.summary.count, 1);
    assert.equal(output.data.summary.first, '2026-09-01');
  });
});

test('maps account balance history uploads exactly once', async () => {
  uploadedBalanceHistory.length = 0;
  await withClient(async (client) => {
    const csvContent = 'Date,Amount\n2026-09-01,2500';
    const result = await client.callTool({
      name: 'upload_account_balance_history',
      arguments: { account_id: 'account-123', csv_content: csvContent },
    });
    const output = result.structuredContent as {
      data: { account_id: string; uploaded: boolean };
    };
    assert.deepEqual(uploadedBalanceHistory, [{ accountId: 'account-123', csvContent }]);
    assert.deepEqual(output.data, { account_id: 'account-123', uploaded: true });
  });
});

test('rejects incomplete date ranges before calling Monarch', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'get_transactions',
      arguments: { start_date: '2026-09-01' },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /both start_date and end_date/);
  });
});
