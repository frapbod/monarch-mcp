import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { type ChangeRecord, FileChangeStore } from '../src/changes.js';
import { createServer } from '../src/server.js';
import type { MonarchAccess } from '../src/session.js';

const noUpstream: MonarchAccess = {
  read: async () => assert.fail('History must not read Monarch'),
  write: async () => assert.fail('History must not write Monarch'),
};

interface HistoryPage {
  changes: Array<Omit<ChangeRecord, 'undo' | 'redo' | 'guards' | 'redo_guards' | 'snapshot'>>;
  offset: number;
  next_offset: number | null;
  has_more: boolean;
}

async function withHistory(
  count: number,
  callback: (client: Client, records: ChangeRecord[], store: FileChangeStore) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-history-'));
  const records = Array.from(
    { length: count },
    (_, index): ChangeRecord => ({
      id: `chg_00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`,
      tool: 'update_transaction',
      // Timestamp ties intentionally cross page boundaries.
      created_at: new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 3)).toISOString(),
      affected_count: 1,
      reversible: true,
      status: 'active',
      undo: [{ operation: 'update_transaction', id: 'transaction-1', values: { amount: 1 } }],
      redo: [{ operation: 'update_transaction', id: 'transaction-1', values: { amount: 2 } }],
      guards: [{ kind: 'transaction', id: 'transaction-1', values: { amount: 2 } }],
      redo_guards: [{ kind: 'transaction', id: 'transaction-1', values: { amount: 1 } }],
      snapshot: { private: 'saved state' },
    }),
  );
  // Write in reverse order so enumeration cannot rely on insertion order.
  for (const record of [...records].reverse()) {
    writeFileSync(join(directory, `${record.id}.json`), JSON.stringify(record));
  }
  const before = readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8'));
  const store = new FileChangeStore(directory);
  const handler = createMcpHandler(() => createServer(noUpstream, store));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'change-history-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await callback(client, [...records].reverse(), store);
    assert.deepEqual(
      readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8')),
      before,
      'History reads must leave journal and recovery records unchanged',
    );
  } finally {
    await client.close();
    await handler.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
}

async function history(client: Client, args: Record<string, unknown> = {}): Promise<HistoryPage> {
  const result = await client.callTool({ name: 'get_change_history', arguments: args });
  assert.notEqual(result.isError, true);
  const output = result.structuredContent as { data: HistoryPage; meta: { source: string } };
  assert.equal(output.meta.source, 'monarch');
  assert.deepEqual(result.content, [
    { type: 'text', text: `Retrieved ${output.data.changes.length} recorded Monarch changes.` },
  ]);
  for (const record of output.data.changes) {
    for (const field of ['undo', 'redo', 'guards', 'redo_guards', 'snapshot']) {
      assert.equal(field in record, false);
    }
  }
  return output.data;
}

test('history enumerates 205 records exactly once through bounded pages and preserves detail', async () => {
  await withHistory(205, async (client, records, store) => {
    const expectedIds = records.map(({ id }) => id);
    const initial = await history(client);
    assert.equal(initial.changes.length, 20);
    assert.equal(initial.offset, 0);
    assert.equal(initial.next_offset, 20);
    assert.equal(initial.has_more, true);
    assert.deepEqual(
      initial.changes.map(({ id }) => id),
      expectedIds.slice(0, 20),
    );
    assert.deepEqual(
      store.list(20).map(({ id }) => id),
      expectedIds.slice(0, 20),
    );
    assert.deepEqual(
      store.list(20, 100).map(({ id }) => id),
      expectedIds.slice(100, 120),
    );

    const seen: string[] = [];
    let offset: number | null = 0;
    for (const size of [100, 100, 5]) {
      assert.notEqual(offset, null);
      const page = await history(client, { limit: 100, offset });
      assert.equal(page.offset, offset);
      assert.equal(page.changes.length, size);
      seen.push(...page.changes.map(({ id }) => id));
      const hasMore = seen.length < records.length;
      assert.equal(page.has_more, hasMore);
      assert.equal(page.next_offset, hasMore ? seen.length : null);
      offset = page.next_offset;
    }
    assert.equal(offset, null);
    assert.deepEqual(seen, expectedIds);
    assert.equal(new Set(seen).size, records.length);

    for (const pastEnd of [205, 206, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(await history(client, { offset: pastEnd }), {
        changes: [],
        offset: pastEnd,
        next_offset: null,
        has_more: false,
      });
    }
    const first = records[0];
    assert.ok(first);
    const detail = await client.callTool({
      name: 'get_change_history',
      arguments: { change_id: first.id, offset: 205, limit: 1 },
    });
    assert.notEqual(detail.isError, true);
    assert.deepEqual((detail.structuredContent as { data: unknown }).data, { change: first });
  });
});

test('history reports terminal empty, single-record, and exactly-full pages', async () => {
  for (const count of [0, 1, 100, 200]) {
    await withHistory(count, async (client, records) => {
      const offset = count === 200 ? 100 : 0;
      const page = await history(client, { limit: 100, offset });
      assert.equal(page.offset, offset);
      assert.equal(page.has_more, false);
      assert.equal(page.next_offset, null);
      assert.deepEqual(
        page.changes.map(({ id }) => id),
        records.slice(offset).map(({ id }) => id),
      );
    });
  }
});

test('history validates offset and retains bounded limit validation at the MCP boundary', async () => {
  await withHistory(0, async (client) => {
    const tools = await client.listTools();
    const spec = tools.tools.find(({ name }) => name === 'get_change_history');
    assert.ok(spec);
    assert.deepEqual(Object.keys(spec.inputSchema.properties ?? {}).sort(), [
      'change_id',
      'limit',
      'offset',
    ]);
    for (const offset of [-1, 0.5, '1', null, true, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await client.callTool({ name: 'get_change_history', arguments: { offset } });
      assert.equal(result.isError, true, `Invalid offset accepted: ${JSON.stringify(offset)}`);
    }
    for (const limit of [0, -1, 101, 0.5, '20']) {
      const result = await client.callTool({ name: 'get_change_history', arguments: { limit } });
      assert.equal(result.isError, true, `Invalid limit accepted: ${JSON.stringify(limit)}`);
    }
    assert.deepEqual(await history(client, { offset: 0, limit: 1 }), {
      changes: [],
      offset: 0,
      next_offset: null,
      has_more: false,
    });
  });
});
