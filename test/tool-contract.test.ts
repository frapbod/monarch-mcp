import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createServer } from '../src/server.js';
import { FileChangeStore } from '../src/changes.js';
import type { MonarchAccess, MonarchClient } from '../src/session.js';

interface Call {
  readonly method: string;
  readonly args: unknown[];
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

const transaction = {
  id: 'transaction-1',
  amount: 10,
  date: '2026-09-01',
  merchant: { id: 'merchant-1', name: 'Merchant' },
  category: { id: 'category-1', name: 'Category' },
  account: { id: 'account-1', displayName: 'Checking' },
  tags: [],
};

function responseFor(method: string): unknown {
  const responses: Record<string, unknown> = {
    getAccounts: { accounts: [account], householdPreferences: {} },
    getAccountHoldings: { portfolio: { aggregateHoldings: { edges: [] } } },
    getAccountHistory: [],
    getRecentAccountBalances: { accounts: [] },
    getAggregateSnapshots: { aggregateSnapshots: [] },
    getAccountSnapshotsByType: { snapshotsByAccountType: [] },
    getAccountTypeOptions: { accountTypeOptions: [] },
    getInstitutions: { credentials: [], accounts: [], subscription: {} },
    getSubscriptionDetails: { subscription: {} },
    isAccountsRefreshComplete: true,
    requestAccountsRefreshAndWait: true,
    requestAccountsRefresh: undefined,
    getTransactions: { allTransactions: { totalCount: 1, results: [transaction] } },
    getTransactionsSummary: { aggregates: [{ summary: { count: 1 } }] },
    getTransactionDetails: { transaction },
    getTransactionSplits: { transaction: { ...transaction, splitTransactions: [] } },
    getTransactionCategories: { categories: [{ id: 'category-1', name: 'Category' }] },
    getTransactionCategoryGroups: { categoryGroups: [{ id: 'group-1', name: 'Group' }] },
    getTransactionTags: { tags: [{ id: 'tag-1', name: 'Tag' }] },
    getBudgets: { budgetData: {}, goalsV2: [] },
    getCashflow: { summary: [] },
    getCashflowSummary: { summary: [] },
    getRecurringTransactions: { recurringTransactionItems: [] },
    getAllTransactions: [],
    createManualAccount: {
      createManualAccount: { account: { id: 'account-2' }, errors: [] },
    },
    updateAccount: { updateAccount: { account, errors: [] } },
    deleteAccount: { deleteAccount: { deleted: true, errors: [] } },
    createTransaction: {
      createTransaction: { transaction: { id: 'transaction-2' }, errors: [] },
    },
    createTransactionTag: {
      createTransactionTag: {
        tag: { id: 'tag-2', name: 'MCP-Test-Tag', color: '#4F46E5', order: 2 },
        errors: [],
      },
    },
    createTransactionCategory: {
      createCategory: { category: { id: 'category-2', name: 'MCP-Test-Category' }, errors: [] },
    },
    getTransactionRules: {
      transactionRules: [
        {
          id: 'rule-1',
          order: 1,
          merchantNameCriteria: [{ operator: 'contains', value: 'merchant' }],
          setCategoryAction: { id: 'category-1', name: 'Category' },
        },
      ],
    },
    createTransactionRule: {
      id: 'rule-2',
      order: 2,
      merchantNameCriteria: [{ operator: 'contains', value: 'new' }],
      setCategoryAction: { id: 'category-1', name: 'Category' },
      recentApplicationCount: 0,
    },
    updateTransactionRule: {
      id: 'rule-1',
      order: 1,
      merchantNameCriteria: [{ operator: 'contains', value: 'merchant' }],
      setCategoryAction: { id: 'category-2', name: 'Updated' },
    },
    deleteTransactionRule: true,
    updateRecurringMerchant: {
      updateMerchant: {
        merchant: { id: 'merchant-1', name: 'Merchant', recurringTransactionStream: null },
        errors: [],
      },
    },
  };
  return responses[method] ?? { ok: true };
}

function fakeAccess(calls: Call[]): MonarchAccess {
  const client = new Proxy(
    {},
    {
      get:
        (_target, property) =>
        async (...args: unknown[]) => {
          const method = String(property);
          calls.push({ method, args });
          return responseFor(method);
        },
    },
  ) as MonarchClient;
  return {
    read: async (operation) => operation(client),
    write: async (operation) => operation(client),
  };
}

async function callTool(
  access: MonarchAccess,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-contract-'));
  const handler = createMcpHandler(() => createServer(access, new FileChangeStore(directory)));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'tool-contract-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.ok(result.structuredContent);
  } finally {
    await client.close();
    await handler.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

interface ToolCase {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly method: string;
  readonly upstreamArgs: unknown[];
}

const cases: ToolCase[] = [
  { name: 'get_accounts', args: { detail: 'compact' }, method: 'getAccounts', upstreamArgs: [] },
  {
    name: 'get_account_holdings',
    args: { account_id: 'account-1' },
    method: 'getAccountHoldings',
    upstreamArgs: ['account-1'],
  },
  {
    name: 'get_account_history',
    args: { account_id: 'account-1' },
    method: 'getAccountHistory',
    upstreamArgs: ['account-1'],
  },
  {
    name: 'get_recent_account_balances',
    args: { start_date: '2026-09-01' },
    method: 'getRecentAccountBalances',
    upstreamArgs: ['2026-09-01'],
  },
  {
    name: 'get_net_worth_history',
    args: { start_date: '2026-08-01', end_date: '2026-09-01', account_type: 'asset' },
    method: 'getAggregateSnapshots',
    upstreamArgs: [{ startDate: '2026-08-01', endDate: '2026-09-01', accountType: 'asset' }],
  },
  {
    name: 'get_account_snapshots_by_type',
    args: { start_date: '2026-01-01', timeframe: 'month' },
    method: 'getAccountSnapshotsByType',
    upstreamArgs: ['2026-01-01', 'month'],
  },
  {
    name: 'get_account_type_options',
    args: {},
    method: 'getAccountTypeOptions',
    upstreamArgs: [],
  },
  { name: 'get_institutions', args: {}, method: 'getInstitutions', upstreamArgs: [] },
  { name: 'get_subscription', args: {}, method: 'getSubscriptionDetails', upstreamArgs: [] },
  {
    name: 'get_refresh_status',
    args: { account_ids: ['account-1'] },
    method: 'isAccountsRefreshComplete',
    upstreamArgs: [['account-1']],
  },
  {
    name: 'create_manual_account',
    args: {
      name: 'MCP-Test-Account',
      account_type: 'asset',
      account_subtype: 'checking',
      balance: 1,
      include_in_net_worth: false,
    },
    method: 'createManualAccount',
    upstreamArgs: [
      {
        accountName: 'MCP-Test-Account',
        accountType: 'asset',
        accountSubType: 'checking',
        accountBalance: 1,
        isInNetWorth: false,
      },
    ],
  },
  {
    name: 'update_account',
    args: {
      account_id: 'account-1',
      name: 'Renamed',
      balance: 2,
      include_in_net_worth: false,
      hide_from_summary: true,
      hide_transactions_from_reports: true,
    },
    method: 'updateAccount',
    upstreamArgs: [
      'account-1',
      {
        accountName: 'Renamed',
        accountBalance: 2,
        includeInNetWorth: false,
        hideFromSummaryList: true,
        hideTransactionsFromReports: true,
      },
    ],
  },
  {
    name: 'upload_account_balance_history',
    args: { account_id: 'account-1', csv_content: 'Date,Amount\n2026-09-01,10' },
    method: 'uploadAccountBalanceHistory',
    upstreamArgs: ['account-1', 'Date,Amount\n2026-09-01,10'],
  },
  {
    name: 'delete_account',
    args: { account_id: 'account-1' },
    method: 'deleteAccount',
    upstreamArgs: ['account-1'],
  },
  {
    name: 'get_transactions',
    args: {
      limit: 25,
      offset: 10,
      start_date: '2026-08-01',
      end_date: '2026-09-01',
      search: 'Merchant',
      category_ids: ['category-1'],
      account_ids: ['account-1'],
      tag_ids: ['tag-1'],
      has_notes: true,
      detail: 'compact',
    },
    method: 'getTransactions',
    upstreamArgs: [
      {
        limit: 25,
        offset: 10,
        startDate: '2026-08-01',
        endDate: '2026-09-01',
        search: 'Merchant',
        categoryIds: ['category-1'],
        accountIds: ['account-1'],
        tagIds: ['tag-1'],
        hasNotes: true,
      },
    ],
  },
  {
    name: 'get_transactions_summary',
    args: {},
    method: 'getTransactionsSummary',
    upstreamArgs: [],
  },
  {
    name: 'get_transaction',
    args: { transaction_id: 'transaction-1' },
    method: 'getTransactionDetails',
    upstreamArgs: ['transaction-1'],
  },
  {
    name: 'get_transaction_splits',
    args: { transaction_id: 'transaction-1' },
    method: 'getTransactionSplits',
    upstreamArgs: ['transaction-1'],
  },
  {
    name: 'get_transaction_categories',
    args: {},
    method: 'getTransactionCategories',
    upstreamArgs: [],
  },
  {
    name: 'get_transaction_category_groups',
    args: {},
    method: 'getTransactionCategoryGroups',
    upstreamArgs: [],
  },
  {
    name: 'get_transaction_tags',
    args: {},
    method: 'getTransactionTags',
    upstreamArgs: [],
  },
  {
    name: 'create_transaction',
    args: {
      date: '2026-09-01',
      account_id: 'account-1',
      amount: 10,
      merchant_name: 'MCP-Test-Merchant',
      category_id: 'category-1',
      notes: 'MCP-Test',
      update_account_balance: false,
    },
    method: 'createTransaction',
    upstreamArgs: [
      {
        date: '2026-09-01',
        accountId: 'account-1',
        amount: 10,
        merchantName: 'MCP-Test-Merchant',
        categoryId: 'category-1',
        notes: 'MCP-Test',
        updateBalance: false,
      },
    ],
  },
  {
    name: 'update_transaction',
    args: {
      transaction_id: 'transaction-1',
      merchant_name: 'Updated',
      amount: 11,
      hidden_from_reports: true,
      needs_review: false,
    },
    method: 'updateTransaction',
    upstreamArgs: [
      'transaction-1',
      { merchantName: 'Updated', amount: 11, hideFromReports: true, needsReview: false },
    ],
  },
  {
    name: 'delete_transaction',
    args: { transaction_id: 'transaction-1' },
    method: 'deleteTransaction',
    upstreamArgs: ['transaction-1'],
  },
  {
    name: 'set_transaction_splits',
    args: {
      transaction_id: 'transaction-1',
      splits: [{ merchant_name: 'Split', amount: 10, category_id: 'category-1' }],
    },
    method: 'updateTransactionSplits',
    upstreamArgs: [
      'transaction-1',
      [{ merchantName: 'Split', amount: 10, categoryId: 'category-1' }],
    ],
  },
  {
    name: 'set_transaction_tags',
    args: { transaction_id: 'transaction-1', tag_ids: ['tag-1'] },
    method: 'setTransactionTags',
    upstreamArgs: ['transaction-1', ['tag-1']],
  },
  {
    name: 'create_transaction_tag',
    args: { name: 'MCP-Test-Tag', color: '#4F46E5' },
    method: 'createTransactionTag',
    upstreamArgs: ['MCP-Test-Tag', '#4F46E5'],
  },
  {
    name: 'delete_transaction_tag',
    args: { tag_id: 'tag-1' },
    method: 'deleteTransactionTag',
    upstreamArgs: ['tag-1'],
  },
  {
    name: 'create_transaction_category',
    args: { group_id: 'group-1', name: 'MCP-Test-Category' },
    method: 'createTransactionCategory',
    upstreamArgs: [{ groupId: 'group-1', name: 'MCP-Test-Category', rolloverEnabled: false }],
  },
  {
    name: 'delete_transaction_category',
    args: { category_id: 'category-1', move_to_category_id: 'category-2' },
    method: 'deleteTransactionCategory',
    upstreamArgs: ['category-1', 'category-2'],
  },
  {
    name: 'get_budgets',
    args: { start_date: '2026-08-01', end_date: '2026-09-01' },
    method: 'getBudgets',
    upstreamArgs: ['2026-08-01', '2026-09-01'],
  },
  {
    name: 'set_budget_amount',
    args: {
      amount: 12,
      category_id: 'category-1',
      start_date: '2026-09-01',
      apply_to_future: true,
    },
    method: 'setBudgetAmount',
    upstreamArgs: [
      { amount: 12, categoryId: 'category-1', startDate: '2026-09-01', applyToFuture: true },
    ],
  },
  {
    name: 'get_cashflow',
    args: { start_date: '2026-08-01', end_date: '2026-09-01' },
    method: 'getCashflow',
    upstreamArgs: [{ startDate: '2026-08-01', endDate: '2026-09-01' }],
  },
  {
    name: 'get_cashflow_summary',
    args: { start_date: '2026-08-01', end_date: '2026-09-01' },
    method: 'getCashflowSummary',
    upstreamArgs: [{ startDate: '2026-08-01', endDate: '2026-09-01' }],
  },
  {
    name: 'get_recurring_transactions',
    args: { start_date: '2026-08-01', end_date: '2026-09-01' },
    method: 'getRecurringTransactions',
    upstreamArgs: ['2026-08-01', '2026-09-01'],
  },
  {
    name: 'get_goals',
    args: { start_date: '2026-08-01', end_date: '2026-09-01' },
    method: 'getBudgets',
    upstreamArgs: ['2026-08-01', '2026-09-01'],
  },
  {
    name: 'update_recurring_merchant',
    args: {
      transaction_id: 'transaction-1',
      is_recurring: true,
      frequency: 'monthly',
      base_date: '2026-09-01',
      amount: 10,
      is_active: true,
    },
    method: 'updateRecurringMerchant',
    upstreamArgs: [
      {
        merchantId: 'merchant-1',
        name: 'Merchant',
        isRecurring: true,
        frequency: 'monthly',
        baseDate: '2026-09-01',
        amount: 10,
        isActive: true,
      },
    ],
  },
  {
    name: 'get_transaction_rules',
    args: {},
    method: 'getTransactionRules',
    upstreamArgs: [],
  },
  {
    name: 'preview_transaction_rule',
    args: { merchant_name_criteria: [{ operator: 'contains', value: 'merchant' }] },
    method: 'getAllTransactions',
    upstreamArgs: [{ pageSize: 500 }],
  },
  {
    name: 'create_transaction_rule',
    args: {
      merchant_name_criteria: [{ operator: 'contains', value: 'new' }],
      set_category_action: 'category-1',
    },
    method: 'createTransactionRule',
    upstreamArgs: [
      {
        merchantNameCriteria: [{ operator: 'contains', value: 'new' }],
        setCategoryAction: 'category-1',
      },
    ],
  },
  {
    name: 'update_transaction_rule',
    args: { rule_id: 'rule-1', set_category_action: 'category-2' },
    method: 'updateTransactionRule',
    upstreamArgs: ['rule-1', { setCategoryAction: 'category-2' }],
  },
  {
    name: 'delete_transaction_rule',
    args: { rule_id: 'rule-1' },
    method: 'deleteTransactionRule',
    upstreamArgs: ['rule-1'],
  },
];

for (const toolCase of cases) {
  test(`${toolCase.name} executes its documented upstream operation`, async () => {
    const calls: Call[] = [];
    await callTool(fakeAccess(calls), toolCase.name, toolCase.args);
    assert.deepEqual(
      calls.filter((call) => call.method === toolCase.method),
      [{ method: toolCase.method, args: toolCase.upstreamArgs }],
    );
  });
}

test('refresh_accounts starts, waits, and reads back the requested account', async () => {
  const calls: Call[] = [];
  await callTool(fakeAccess(calls), 'refresh_accounts', {
    account_ids: ['account-1'],
    wait: true,
    timeout_seconds: 10,
    poll_seconds: 1,
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ['getAccounts', 'requestAccountsRefreshAndWait', 'getAccounts'],
  );
  const options = calls[1]?.args[0] as Record<string, unknown>;
  assert.deepEqual(options.accountIds, ['account-1']);
  assert.equal(options.timeout, 10);
  assert.equal(options.delay, 1);
  assert.equal(typeof options.onProgress, 'function');
});
