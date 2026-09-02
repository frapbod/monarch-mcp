#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { readConfig } from './config.js';
import { FileChangeStore, type ChangeStore } from './changes.js';
import { MonarchSession, type MonarchAccess } from './session.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerChangeTools } from './tools/changes.js';
import { registerPlanningTools } from './tools/planning.js';
import { registerRuleTools } from './tools/rules.js';
import { registerTransactionTools } from './tools/transactions.js';

interface PackageMetadata {
  readonly version: string;
}

function packageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageMetadata;
  return metadata.version;
}

export function createServer(
  session: MonarchAccess = new MonarchSession(readConfig()),
  changes: ChangeStore = new FileChangeStore(),
): McpServer {
  const server = new McpServer(
    { name: 'monarch-money', version: packageVersion() },
    {
      instructions:
        'Use IDs returned by read tools. Preview transaction rules before applying them retroactively. Successful mutations return a durable local change_id; inspect it with get_change_history and reverse it with undo_change. A normal undo refuses to overwrite newer state; force only after inspection. This server cannot move money or make payments.',
    },
  );
  registerAccountTools(server, session, changes);
  registerTransactionTools(server, session, changes);
  registerPlanningTools(server, session, changes);
  registerRuleTools(server, session, changes);
  registerChangeTools(server, session, changes);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = serveStdio(() => createServer());
  const close = () => void handle.close();
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  console.error(`monarch-money MCP ${packageVersion()} listening on stdio`);
}
