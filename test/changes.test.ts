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

test('undo and redo protect targeted fields without blocking unrelated edits', async () => {
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
      if (typeof updates.notes === 'string') transaction.notes = updates.notes;
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

      transaction.notes = 'Unrelated human edit';
      const undone = await mcp.callTool({
        name: 'undo_change',
        arguments: { change_id: updateData.data.change_id },
      });
      assert.notEqual(undone.isError, true);
      assert.equal(transaction.merchant.name, 'Old merchant');
      assert.equal(transaction.needsReview, true);
      assert.equal(transaction.notes, 'Unrelated human edit');
      assert.equal(changes.get(updateData.data.change_id)?.status, 'undone');
      assert.ok(changes.get(updateData.data.change_id)?.redo_guards?.length);

      transaction.merchant.name = 'Newer human edit';
      const conflicted = await mcp.callTool({
        name: 'redo_change',
        arguments: { change_id: updateData.data.change_id },
      });
      assert.equal(conflicted.isError, true);
      assert.match(JSON.stringify(conflicted.content), /conflicts with newer Monarch state/);
      assert.equal(transaction.merchant.name, 'Newer human edit');
      assert.equal(changes.get(updateData.data.change_id)?.status, 'undone');

      const redone = await mcp.callTool({
        name: 'redo_change',
        arguments: { change_id: updateData.data.change_id, force: true },
      });
      assert.notEqual(redone.isError, true);
      assert.equal(transaction.merchant.name, 'New merchant');
      assert.equal(transaction.needsReview, false);
      assert.equal(transaction.notes, 'Unrelated human edit');
      assert.equal(changes.get(updateData.data.change_id)?.status, 'active');

      const repeated = await mcp.callTool({
        name: 'redo_change',
        arguments: { change_id: updateData.data.change_id },
      });
      assert.match(JSON.stringify(repeated.content), /already redone/);
      assert.equal(transaction.merchant.name, 'New merchant');
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

test('an update with no readable outcome stays uncertain and requires forced recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-ambiguous-'));
  const changes = new FileChangeStore(directory);
  let reads = 0;
  const client = {
    getTransactionDetails: async () => {
      reads += 1;
      if (reads > 1) throw new Error('readback unavailable');
      return {
        transaction: {
          id: 'transaction-1',
          amount: -10,
          date: '2026-09-01',
          notes: '',
          hideFromReports: false,
          needsReview: true,
          category: { id: 'category-1' },
          merchant: { name: 'Old merchant' },
          goal: null,
          tags: [],
        },
      };
    },
    updateTransaction: async () => {
      throw new Error('connection closed after request');
    },
  } as unknown as MonarchClient;
  const access: MonarchAccess = {
    read: async (operation) => operation(client),
    write: async (operation) => operation(client),
  };

  try {
    await withClient(access, changes, async (mcp) => {
      const result = await mcp.callTool({
        name: 'update_transaction',
        arguments: { transaction_id: 'transaction-1', merchant_name: 'New merchant' },
      });
      const output = result.structuredContent as { data: { change_id: string; status: string } };
      assert.equal(output.data.status, 'ambiguous');
      assert.equal(changes.get(output.data.change_id)?.status, 'uncertain');

      const undo = await mcp.callTool({
        name: 'undo_change',
        arguments: { change_id: output.data.change_id },
      });
      assert.equal(undo.isError, true);
      assert.match(JSON.stringify(undo.content), /uncertain upstream outcome/);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an ambiguous but observed update still requires explicit forced recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-observed-'));
  const changes = new FileChangeStore(directory);
  const transaction = {
    id: 'transaction-1',
    amount: -10,
    date: '2026-09-01',
    notes: '',
    hideFromReports: false,
    needsReview: true,
    category: { id: 'category-1' },
    merchant: { name: 'Old merchant' },
    goal: null,
    tags: [],
  };
  const client = {
    getTransactionDetails: async () => ({ transaction: structuredClone(transaction) }),
    updateTransaction: async () => ({ updateTransaction: { transaction: null, errors: [] } }),
  } as unknown as MonarchClient;
  const access: MonarchAccess = {
    read: async (operation) => operation(client),
    write: async (operation) => operation(client),
  };

  try {
    await withClient(access, changes, async (mcp) => {
      const result = await mcp.callTool({
        name: 'update_transaction',
        arguments: { transaction_id: 'transaction-1', merchant_name: 'New merchant' },
      });
      const output = result.structuredContent as { data: { change_id: string; status: string } };
      assert.equal(output.data.status, 'ambiguous');
      assert.equal(changes.get(output.data.change_id)?.status, 'uncertain');
      assert.ok(changes.get(output.data.change_id)?.guards?.length);

      transaction.merchant.name = 'Later human edit';
      const undo = await mcp.callTool({
        name: 'undo_change',
        arguments: { change_id: output.data.change_id },
      });
      assert.equal(undo.isError, true);
      assert.match(JSON.stringify(undo.content), /uncertain upstream outcome/);
      assert.equal(transaction.merchant.name, 'Later human edit');
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bulk and recurring updates retain uncertain recovery state when readback fails', async () => {
  for (const tool of ['bulk_update_transactions', 'update_recurring_merchant'] as const) {
    const directory = mkdtempSync(join(tmpdir(), `monarch-mcp-${tool}-`));
    const changes = new FileChangeStore(directory);
    let reads = 0;
    const details = {
      transaction: {
        id: 'transaction-1',
        amount: -10,
        date: '2026-09-01',
        notes: '',
        hideFromReports: false,
        needsReview: true,
        category: { id: 'category-1' },
        merchant: {
          id: 'merchant-1',
          name: 'Merchant',
          recurringTransactionStream: {
            frequency: 'monthly',
            baseDate: '2026-09-01',
            amount: -10,
            isActive: true,
          },
        },
        goal: null,
        tags: [],
      },
    };
    const client = {
      getTransactionDetails: async () => {
        reads += 1;
        if (reads > 1) throw new Error('readback unavailable');
        return structuredClone(details);
      },
      updateTransaction: async () => {
        throw new Error('connection closed after request');
      },
      updateRecurringMerchant: async () => {
        throw new Error('connection closed after request');
      },
    } as unknown as MonarchClient;
    const access: MonarchAccess = {
      read: async (operation) => operation(client),
      write: async (operation) => operation(client),
    };

    try {
      await withClient(access, changes, async (mcp) => {
        const result =
          tool === 'bulk_update_transactions'
            ? await mcp.callTool({
                name: tool,
                arguments: {
                  updates: [{ transaction_id: 'transaction-1', merchant_name: 'Updated' }],
                },
              })
            : await mcp.callTool({
                name: tool,
                arguments: {
                  transaction_id: 'transaction-1',
                  is_recurring: true,
                  frequency: 'weekly',
                },
              });
        const output = result.structuredContent as {
          data: { change_id: string; status?: string; ambiguous_count?: number };
        };
        assert.ok(output.data.status === 'ambiguous' || output.data.ambiguous_count === 1);
        assert.equal(changes.get(output.data.change_id)?.status, 'uncertain');
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
