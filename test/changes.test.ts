import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { FileChangeStore, journalMutation } from '../src/changes.js';
import { createServer } from '../src/server.js';
import type { MonarchAccess, MonarchClient } from '../src/session.js';

async function withClient(
  access: MonarchAccess,
  changes: FileChangeStore,
  callback: (client: Client) => Promise<void>,
): Promise<void> {
  const handler = createMcpHandler(() => createServer(access, changes));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'change-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    await callback(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('journals, exposes, and idempotently undoes a transaction update', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-changes-'));
  const changes = new FileChangeStore(directory);
  const transaction = {
    id: 'transaction-1',
    amount: -10,
    date: '2026-09-01',
    notes: '',
    hideFromReports: false,
    needsReview: true,
    category: { id: 'category-1', name: 'Old category' },
    merchant: { id: 'merchant-1', name: 'Old merchant' },
    goal: null,
    tags: [],
  };
  const client = {
    getTransactionDetails: async () => ({ transaction: structuredClone(transaction) }),
    updateTransaction: async (_id: string, updates: Record<string, unknown>) => {
      if (typeof updates.merchantName === 'string') {
        transaction.merchant.name = updates.merchantName;
      }
      if (typeof updates.needsReview === 'boolean') {
        transaction.needsReview = updates.needsReview;
      }
      return { updateTransaction: { transaction: { id: transaction.id }, errors: [] } };
    },
  } as unknown as MonarchClient;
  const access: MonarchAccess = {
    read: async (operation) => operation(client),
    write: async (operation) => operation(client),
  };

  try {
    await withClient(access, changes, async (mcp) => {
      const updated = await mcp.callTool({
        name: 'update_transaction',
        arguments: {
          transaction_id: 'transaction-1',
          merchant_name: 'New merchant',
          needs_review: false,
        },
      });
      const updateData = updated.structuredContent as {
        data: { change_id: string; status: string };
      };
      assert.equal(updateData.data.status, 'updated');
      assert.equal(transaction.merchant.name, 'New merchant');
      assert.equal(changes.get(updateData.data.change_id)?.status, 'active');

      transaction.merchant.name = 'Newer human edit';
      const conflicted = await mcp.callTool({
        name: 'undo_change',
        arguments: { change_id: updateData.data.change_id },
      });
      assert.equal(conflicted.isError, true);
      assert.match(JSON.stringify(conflicted.content), /conflicts with newer Monarch state/);
      assert.equal(transaction.merchant.name, 'Newer human edit');
      assert.equal(changes.get(updateData.data.change_id)?.status, 'active');

      const undone = await mcp.callTool({
        name: 'undo_change',
        arguments: { change_id: updateData.data.change_id, force: true },
      });
      assert.notEqual(undone.isError, true);
      assert.equal(transaction.merchant.name, 'Old merchant');
      assert.equal(transaction.needsReview, true);
      assert.equal(changes.get(updateData.data.change_id)?.status, 'undone');

      const repeated = await mcp.callTool({
        name: 'undo_change',
        arguments: { change_id: updateData.data.change_id },
      });
      assert.match(JSON.stringify(repeated.content), /already undone/);
      assert.equal(transaction.merchant.name, 'Old merchant');
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('records inverse operations atomically and lists newest changes first', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-store-'));
  const changes = new FileChangeStore(directory);
  try {
    const first = changes.record({
      tool: 'update_transaction',
      affected_count: 1,
      reversible: true,
      undo: [{ operation: 'update_transaction', id: 'transaction-1', values: { amount: 1 } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = changes.record({
      tool: 'update_recurring_merchant',
      affected_count: 1,
      reversible: true,
      undo: [
        {
          operation: 'update_recurring_merchant',
          values: { merchantId: 'merchant-1', name: 'Merchant', isRecurring: false },
        },
      ],
    });
    assert.deepEqual(
      changes.list(2).map(({ id }) => id),
      [second.id, first.id],
    );
    assert.deepEqual(changes.get(first.id)?.undo, first.undo);
    assert.equal(changes.markUndone(first.id).status, 'undone');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writes the change ID before mutation and retains uncertain outcomes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-wal-'));
  const changes = new FileChangeStore(directory);
  let idDuringMutation: string | undefined;
  try {
    await assert.rejects(
      journalMutation(
        changes,
        {
          tool: 'update_transaction',
          affected_count: 1,
          reversible: true,
          undo: [{ operation: 'update_transaction', id: 'transaction-1', values: { amount: 1 } }],
        },
        async () => {
          const prepared = changes.list(1)[0];
          assert.equal(prepared?.status, 'prepared');
          idDuringMutation = prepared?.id;
          throw new Error('connection closed after request');
        },
      ),
      /Mutation outcome is uncertain; inspect change chg_/,
    );
    assert.ok(idDuringMutation);
    assert.equal(changes.get(idDuringMutation)?.status, 'uncertain');

    await assert.rejects(
      journalMutation(
        changes,
        {
          tool: 'create_transaction',
          affected_count: 1,
          reversible: false,
          undo: [],
        },
        async () => ({ accepted: true }),
        () => {
          throw new Error('accepted response omitted its ID');
        },
      ),
      /Mutation outcome is uncertain; inspect change chg_/,
    );
    assert.equal(changes.list(1)[0]?.status, 'uncertain');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
