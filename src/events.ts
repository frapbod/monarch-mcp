import { appendFileSync } from 'node:fs';

interface ToolEvent {
  readonly tool: string;
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly errorKind?: string;
}

export function classifyError(error: unknown): string {
  const value = error as { name?: unknown; statusCode?: unknown } | null;
  const status = Number(value?.statusCode);
  if (status === 401 || status === 403) return 'authentication';
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `http_${status}`;
  const name = String(value?.name ?? '').toLowerCase();
  if (name.includes('login') || name.includes('auth')) return 'authentication';
  if (name.includes('timeout') || name.includes('abort')) return 'timeout';
  return 'upstream';
}

export function emitToolEvent(event: ToolEvent): void {
  const payload = {
    component: 'monarch-mcp',
    event: 'monarch_mcp.tool.completed',
    timestamp: new Date().toISOString(),
    tool: event.tool,
    outcome: event.outcome,
    duration_ms: Math.max(0, Math.round(event.durationMs * 10) / 10),
    read_only: event.readOnly,
    destructive: event.destructive,
    idempotent: event.idempotent,
    ...(event.errorKind ? { error_kind: event.errorKind } : {}),
  };
  const line = `${JSON.stringify(payload)}\n`;
  try {
    const path = process.env.MONARCH_MCP_EVENT_LOG;
    if (path) appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Telemetry must not change a finance operation's result.
  }
}
