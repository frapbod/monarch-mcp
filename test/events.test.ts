import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { AuthenticationError, InputValidationError, RequestCancelledError } from '../src/errors.js';
import { classifyError } from '../src/events.js';
import { createServer } from '../src/server.js';
import type { MonarchAccess, MonarchClient } from '../src/session.js';

test('classifies local and upstream failures accurately', () => {
  assert.equal(classifyError(new InputValidationError('invalid')), 'validation');
  assert.equal(classifyError(new AuthenticationError('denied')), 'authentication');
  assert.equal(classifyError(new RequestCancelledError('cancelled')), 'cancelled');
  assert.equal(classifyError(Object.assign(new Error('request'), { statusCode: 429 })), 'http_429');
  assert.equal(classifyError(new Error('response shape changed')), 'upstream');
});

async function invoke(access: MonarchAccess, accountId: string): Promise<boolean> {
  const handler = createMcpHandler(() => createServer(access));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'event-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'get_account_history',
      arguments: { account_id: accountId },
    });
    return result.isError === true;
  } finally {
    await client.close();
    await handler.close();
  }
}

test('tool events record outcomes and latency without arguments, results, or raw errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'monarch-mcp-events-'));
  const path = join(directory, 'events.jsonl');
  const previous = process.env.MONARCH_MCP_EVENT_LOG;
  process.env.MONARCH_MCP_EVENT_LOG = path;
  try {
    const success: MonarchAccess = {
      read: async (operation) =>
        operation({
          getAccountHistory: async () => [{ sentinelResult: true }],
        } as unknown as MonarchClient),
      write: async (operation) => operation({} as MonarchClient),
    };
    assert.equal(await invoke(success, 'sentinel-account-id'), false);

    const requestError = Object.assign(new Error('sentinel upstream body'), { statusCode: 400 });
    const failure: MonarchAccess = {
      read: async () => {
        throw requestError;
      },
      write: async (operation) => operation({} as MonarchClient),
    };
    assert.equal(await invoke(failure, 'sentinel-account-id'), true);

    const cancelled: MonarchAccess = {
      read: async () => {
        throw new RequestCancelledError('sentinel cancellation');
      },
      write: async (operation) => operation({} as MonarchClient),
    };
    assert.equal(await invoke(cancelled, 'sentinel-account-id'), true);

    const raw = readFileSync(path, 'utf8');
    assert.doesNotMatch(raw, /sentinel/);
    const events = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map(({ event, tool, outcome, error_kind }) => ({
        event,
        tool,
        outcome,
        error_kind,
      })),
      [
        {
          event: 'monarch_mcp.tool.completed',
          tool: 'get_account_history',
          outcome: 'success',
          error_kind: undefined,
        },
        {
          event: 'monarch_mcp.tool.completed',
          tool: 'get_account_history',
          outcome: 'error',
          error_kind: 'http_400',
        },
        {
          event: 'monarch_mcp.tool.completed',
          tool: 'get_account_history',
          outcome: 'cancelled',
          error_kind: 'cancelled',
        },
      ],
    );
    assert.ok(events.every((event) => event.duration_ms >= 0));
  } finally {
    if (previous === undefined) delete process.env.MONARCH_MCP_EVENT_LOG;
    else process.env.MONARCH_MCP_EVENT_LOG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
