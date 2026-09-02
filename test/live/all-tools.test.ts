import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const PREFIX = 'MCP-Test-';
const NORMALIZED_PREFIX = PREFIX.toLocaleLowerCase();

// biome-ignore lint/suspicious/noExplicitAny: Monarch's unsupported API has no stable response schema.
type Data = Record<string, any>;

function data(
  result: { isError?: boolean | undefined; structuredContent?: unknown; content?: unknown },
  tool: string,
): Data {
  assert.notEqual(
    result.isError,
    true,
    `${tool} returned an MCP error: ${JSON.stringify(result.content)}`,
  );
  assert.ok(result.structuredContent, `${tool} returned no structured content`);
  return (result.structuredContent as { data: Data }).data;
}

async function call(client: Client, tool: string, args: Data = {}): Promise<Data> {
  return data(await client.callTool({ name: tool, arguments: args }, { timeout: 360_000 }), tool);
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function priorDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 2);
  return date.toISOString().slice(0, 10);
}

function transactionName(transaction: Data): string {
  return String(transaction.merchant?.name ?? '');
}

function testName(value: unknown): boolean {
  return String(value ?? '')
    .toLocaleLowerCase()
    .startsWith(NORMALIZED_PREFIX);
}

async function sweep(client: Client): Promise<void> {
  const rules = (await call(client, 'get_transaction_rules')).transactionRules as Data[];
  for (const rule of rules.filter((item) =>
    JSON.stringify(item).toLocaleLowerCase().includes(NORMALIZED_PREFIX),
  )) {
    await call(client, 'delete_transaction_rule', { rule_id: rule.id });
  }

  const transactions = (
    await call(client, 'get_transactions', {
      search: PREFIX,
      limit: 500,
      detail: 'compact',
    })
  ).transactions as Data[];
  for (const transaction of transactions.filter((item) => testName(transactionName(item)))) {
    await call(client, 'delete_transaction', { transaction_id: transaction.id });
  }

  const tags = (await call(client, 'get_transaction_tags')).tags as Data[];
  for (const tag of tags.filter((item) => testName(item.name))) {
    await call(client, 'delete_transaction_tag', { tag_id: tag.id });
  }

  const categories = (await call(client, 'get_transaction_categories')).categories as Data[];
  for (const category of categories.filter((item) => testName(item.name))) {
    await call(client, 'set_budget_amount', { amount: 0, category_id: category.id });
    await call(client, 'delete_transaction_category', { category_id: category.id });
  }

  const accounts = (await call(client, 'get_accounts', { detail: 'compact' })).accounts as Data[];
  for (const account of accounts.filter((item) => testName(item.name))) {
    await call(client, 'delete_account', { account_id: account.id });
  }
}

const live = process.env.MONARCH_LIVE_TEST === '1' ? test : test.skip;

live('every tool passes a self-cleaning live lifecycle', { timeout: 600_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/server.js'],
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'monarch-live-validation', version: '1.0.0' });
  await client.connect(transport);

  try {
    await sweep(client);

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 47);

    const accounts = (await call(client, 'get_accounts', { detail: 'full' })).accounts as Data[];
    assert.ok(accounts.length > 0, 'get_accounts returned no accounts');
    const firstAccount = accounts[0];
    assert.ok(firstAccount);
    const linkedAccount = accounts.find(
      (account) =>
        !account.isManual &&
        !account.deactivatedAt &&
        account.credential &&
        !account.credential.updateRequired &&
        !account.credential.disconnectedFromDataProviderAt,
    );
    const investmentAccount = accounts.find(
      (account) => Number(account.holdingsCount) > 0 || account.type?.name === 'investment',
    );
    assert.ok(linkedAccount, 'no linked account is available for refresh validation');
    assert.ok(investmentAccount, 'no investment account is available for holdings validation');

    await call(client, 'get_account_holdings', { account_id: investmentAccount.id });
    await call(client, 'get_account_history', { account_id: firstAccount.id });
    await call(client, 'get_recent_account_balances');
    await call(client, 'get_net_worth_history');
    await call(client, 'get_account_snapshots_by_type', {
      start_date: `${new Date().getUTCFullYear()}-01-01`,
      timeframe: 'month',
    });
    const typeOptions = await call(client, 'get_account_type_options');
    await call(client, 'get_institutions');
    await call(client, 'get_subscription');
    await call(client, 'get_refresh_status', { account_ids: [linkedAccount.id] });

    const transactions = (
      await call(client, 'get_transactions', {
        limit: 1,
        detail: 'compact',
      })
    ).transactions as Data[];
    assert.ok(transactions[0]?.id, 'get_transactions returned no usable transaction');
    await call(client, 'get_transactions_summary');
    await call(client, 'get_transaction', { transaction_id: transactions[0].id });
    await call(client, 'get_transaction_splits', { transaction_id: transactions[0].id });
    const categories = (await call(client, 'get_transaction_categories')).categories as Data[];
    const groups = (await call(client, 'get_transaction_category_groups')).categoryGroups as Data[];
    await call(client, 'get_transaction_tags');
    await call(client, 'get_budgets');
    await call(client, 'get_cashflow');
    await call(client, 'get_cashflow_summary');
    await call(client, 'get_recurring_transactions');
    await call(client, 'get_goals');
    await call(client, 'get_change_history', { limit: 5 });
    await call(client, 'get_transactions', { needs_review: true, limit: 1 });
    const recurringCandidates = (
      await call(client, 'get_transactions', { is_recurring: true, limit: 10, detail: 'compact' })
    ).transactions as Data[];
    let recurringTransaction: Data | undefined;
    for (const candidate of recurringCandidates) {
      const detail = (await call(client, 'get_transaction', { transaction_id: candidate.id }))
        .transaction;
      if (detail.merchant?.recurringTransactionStream) {
        recurringTransaction = detail;
        break;
      }
    }
    assert.ok(recurringTransaction, 'no recurring merchant is available for update validation');
    const stream = recurringTransaction.merchant.recurringTransactionStream;
    const recurringUpdate = await call(client, 'update_recurring_merchant', {
      transaction_id: recurringTransaction.id,
      is_recurring: true,
      frequency: stream.frequency,
      base_date: stream.baseDate,
      amount: stream.amount,
      is_active: stream.isActive,
    });
    assert.equal(recurringUpdate.status, 'updated');
    await call(client, 'undo_change', { change_id: recurringUpdate.change_id });

    const option = (typeOptions.accountTypeOptions as Data[]).find(
      (item) => item.type?.name && (item.subtype?.name || item.type?.possibleSubtypes?.[0]?.name),
    );
    assert.ok(option, 'get_account_type_options returned no usable type and subtype');
    const group = groups.find((item) => item.type === 'expense') ?? groups[0];
    assert.ok(group?.id, 'get_transaction_category_groups returned no usable group');
    assert.ok(categories[0]?.id, 'get_transaction_categories returned no usable category');

    const suffix = Date.now().toString(36);
    const accountName = `${PREFIX}Account-${suffix}`;
    const categoryName = `${PREFIX}Category-${suffix}`;
    const tagName = `${PREFIX}Tag-${suffix}`;
    const merchantName = `${PREFIX}Transaction-${suffix}`;
    const ruleMatch = `${PREFIX}Rule-${suffix}`;

    const preview = await call(client, 'preview_transaction_rule', {
      merchant_name_criteria: [{ operator: 'eq', value: ruleMatch }],
    });
    assert.equal(preview.matching_count, 0);
    const createdRule = await call(client, 'create_transaction_rule', {
      merchant_name_criteria: [{ operator: 'eq', value: ruleMatch }],
      set_category_action: categories[0].id,
    });
    const ruleId = createdRule.rule?.id;
    assert.ok(ruleId, 'create_transaction_rule returned no rule ID');
    const updatedRule = await call(client, 'update_transaction_rule', {
      rule_id: ruleId,
      set_merchant_action: `${ruleMatch}-Renamed`,
    });
    assert.equal(updatedRule.rule?.setMerchantAction?.name, `${ruleMatch}-Renamed`);
    await call(client, 'undo_change', { change_id: updatedRule.change_id });
    await call(client, 'undo_change', { change_id: createdRule.change_id });
    assert.ok(
      !((await call(client, 'get_transaction_rules')).transactionRules as Data[]).some(
        (rule) => rule.id === ruleId,
      ),
    );

    const createdAccount = await call(client, 'create_manual_account', {
      name: accountName,
      account_type: option.type.name,
      account_subtype: option.subtype?.name ?? option.type.possibleSubtypes[0].name,
      balance: 1,
      include_in_net_worth: false,
    });
    const accountId = createdAccount.createManualAccount?.account?.id;
    assert.ok(accountId, 'create_manual_account returned no account ID');
    const accountUpdate = await call(client, 'update_account', {
      account_id: accountId,
      name: `${accountName}-Updated`,
      balance: 2,
      include_in_net_worth: false,
    });
    const accountReadback = (await call(client, 'get_accounts', { detail: 'compact' }))
      .accounts as Data[];
    assert.equal(
      accountReadback.find((item) => item.id === accountId)?.name,
      `${accountName}-Updated`,
    );
    await call(client, 'undo_change', { change_id: accountUpdate.change_id });
    const restoredAccounts = (await call(client, 'get_accounts', { detail: 'compact' }))
      .accounts as Data[];
    assert.equal(restoredAccounts.find((item) => item.id === accountId)?.name, accountName);
    assert.equal(restoredAccounts.find((item) => item.id === accountId)?.display_balance, 1);
    await call(client, 'upload_account_balance_history', {
      account_id: accountId,
      csv_content: `Date,Amount\n${priorDate()},2`,
    });
    assert.ok(
      (await call(client, 'get_account_history', { account_id: accountId })).history.length > 0,
    );

    const createdCategory = await call(client, 'create_transaction_category', {
      group_id: group.id,
      name: categoryName,
    });
    const categoryId = createdCategory.createCategory?.category?.id;
    assert.ok(categoryId, 'create_transaction_category returned no category ID');
    const budget = await call(client, 'set_budget_amount', {
      amount: 1,
      category_id: categoryId,
      start_date: currentMonth(),
    });
    assert.equal(budget.updateOrCreateBudgetItem?.budgetItem?.budgetAmount, 1);
    const budgetReadback = await call(client, 'get_budgets', {
      start_date: currentMonth(),
      end_date: currentMonth(),
    });
    assert.match(JSON.stringify(budgetReadback), new RegExp(categoryId));
    await call(client, 'undo_change', { change_id: budget.change_id });

    const createdTag = await call(client, 'create_transaction_tag', {
      name: tagName,
      color: '#4F46E5',
    });
    const tagId = createdTag.createTransactionTag?.tag?.id;
    assert.ok(tagId, 'create_transaction_tag returned no tag ID');
    assert.ok(
      ((await call(client, 'get_transaction_tags')).tags as Data[]).some((tag) => tag.id === tagId),
    );

    const createdTransaction = await call(client, 'create_transaction', {
      date: priorDate(),
      account_id: accountId,
      amount: 1,
      merchant_name: merchantName,
      category_id: categoryId,
      notes: PREFIX,
      update_account_balance: false,
    });
    const transactionId = createdTransaction.createTransaction?.transaction?.id;
    assert.ok(transactionId, 'create_transaction returned no transaction ID');
    const transactionUpdate = await call(client, 'update_transaction', {
      transaction_id: transactionId,
      merchant_name: `${merchantName}-Updated`,
      amount: 2,
      notes: `${PREFIX}Updated`,
    });
    const transactionReadback = (
      await call(client, 'get_transaction', {
        transaction_id: transactionId,
      })
    ).transaction;
    assert.equal(transactionReadback.merchant?.name, `${merchantName}-Updated`);
    assert.equal(transactionReadback.amount, 2);
    await call(client, 'undo_change', { change_id: transactionUpdate.change_id });
    const restoredTransaction = (
      await call(client, 'get_transaction', { transaction_id: transactionId })
    ).transaction;
    assert.equal(restoredTransaction.merchant?.name, merchantName);
    assert.equal(restoredTransaction.amount, 1);
    await call(client, 'redo_change', { change_id: transactionUpdate.change_id });
    const redoneTransaction = (
      await call(client, 'get_transaction', { transaction_id: transactionId })
    ).transaction;
    assert.equal(redoneTransaction.merchant?.name, `${merchantName}-Updated`);
    assert.equal(redoneTransaction.amount, 2);
    await call(client, 'undo_change', { change_id: transactionUpdate.change_id });

    const bulkUpdate = await call(client, 'bulk_update_transactions', {
      updates: [
        {
          transaction_id: transactionId,
          merchant_name: `${merchantName}-Updated`,
          amount: 1,
        },
      ],
    });
    assert.equal(bulkUpdate.updated_count, 1);
    assert.equal(bulkUpdate.failed_count, 0);
    const newerUpdate = await call(client, 'update_transaction', {
      transaction_id: transactionId,
      merchant_name: `${merchantName}-Newer`,
    });
    const conflictedUndo = await client.callTool({
      name: 'undo_change',
      arguments: { change_id: bulkUpdate.change_id },
    });
    assert.equal(conflictedUndo.isError, true, 'undo_change did not protect a newer edit');
    await call(client, 'undo_change', { change_id: newerUpdate.change_id });
    await call(client, 'undo_change', { change_id: bulkUpdate.change_id });

    const tagUpdate = await call(client, 'set_transaction_tags', {
      transaction_id: transactionId,
      tag_ids: [tagId],
    });
    const tagged = (await call(client, 'get_transaction', { transaction_id: transactionId }))
      .transaction;
    assert.ok(tagged.tags.some((tag: Data) => tag.id === tagId));
    await call(client, 'undo_change', { change_id: tagUpdate.change_id });
    const untagged = (await call(client, 'get_transaction', { transaction_id: transactionId }))
      .transaction;
    assert.ok(!untagged.tags.some((tag: Data) => tag.id === tagId));

    const splitUpdate = await call(client, 'set_transaction_splits', {
      transaction_id: transactionId,
      splits: [
        { merchant_name: `${PREFIX}Split-A`, amount: 0.5, category_id: categoryId },
        { merchant_name: `${PREFIX}Split-B`, amount: 0.5, category_id: categoryId },
      ],
    });
    const splitReadback = (
      await call(client, 'get_transaction_splits', {
        transaction_id: transactionId,
      })
    ).transaction;
    assert.equal(splitReadback.splitTransactions.length, 2);
    await call(client, 'undo_change', { change_id: splitUpdate.change_id });
    const unsplitReadback = (
      await call(client, 'get_transaction_splits', { transaction_id: transactionId })
    ).transaction;
    assert.equal(unsplitReadback.splitTransactions.length, 0);

    await call(client, 'delete_transaction', { transaction_id: transactionId });
    const remainingTransactions = (
      await call(client, 'get_transactions', {
        search: merchantName,
        limit: 100,
        detail: 'compact',
      })
    ).transactions as Data[];
    assert.ok(!remainingTransactions.some((item) => item.id === transactionId));

    await call(client, 'delete_transaction_tag', { tag_id: tagId });
    assert.ok(
      !((await call(client, 'get_transaction_tags')).tags as Data[]).some(
        (tag) => tag.id === tagId,
      ),
    );
    await call(client, 'set_budget_amount', { amount: 0, category_id: categoryId });
    await call(client, 'delete_transaction_category', { category_id: categoryId });
    assert.ok(
      !((await call(client, 'get_transaction_categories')).categories as Data[]).some(
        (category) => category.id === categoryId,
      ),
    );
    await call(client, 'delete_account', { account_id: accountId });
    assert.ok(
      !((await call(client, 'get_accounts', { detail: 'compact' })).accounts as Data[]).some(
        (account) => account.id === accountId,
      ),
    );

    const refresh = await call(client, 'refresh_accounts', {
      account_ids: [linkedAccount.id],
      wait: false,
    });
    assert.equal(refresh.complete, null);
    assert.deepEqual(refresh.account_ids, [linkedAccount.id]);
    assert.equal(
      typeof (
        await call(client, 'get_refresh_status', {
          account_ids: [linkedAccount.id],
        })
      ).complete,
      'boolean',
    );
  } finally {
    try {
      await sweep(client);
    } finally {
      await client.close();
    }
  }
});
