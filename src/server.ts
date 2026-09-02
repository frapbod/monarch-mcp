#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { readConfig } from './config.js';
import { MonarchSession, type MonarchAccess } from './session.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerPlanningTools } from './tools/planning.js';
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

export function createServer(session: MonarchAccess = new MonarchSession(readConfig())): McpServer {
  const server = new McpServer({ name: 'monarch-money', version: packageVersion() });
  registerAccountTools(server, session);
  registerTransactionTools(server, session);
  registerPlanningTools(server, session);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = serveStdio(() => createServer());
  const close = () => void handle.close();
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  console.error(`monarch-money MCP ${packageVersion()} listening on stdio`);
}
