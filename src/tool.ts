import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { classifyError, emitToolEvent } from './events.js';
import { InputValidationError } from './errors.js';

export const detailSchema = z
  .enum(['compact', 'full'])
  .default('compact')
  .describe('compact keeps useful fields and every record ID; full returns the upstream payload');

export const dateSchema = z.iso.date().describe('Date in YYYY-MM-DD format');

export function assertDateRange(startDate?: string, endDate?: string): void {
  if (Boolean(startDate) !== Boolean(endDate)) {
    throw new InputValidationError('Supply both start_date and end_date, or omit both');
  }
}

export function invalidInput(message: string): never {
  throw new InputValidationError(message);
}

const pageSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
});

const toolOutputSchema = z.object({
  data: z.unknown(),
  meta: z.object({
    source: z.literal('monarch'),
    retrieved_at: z.iso.datetime(),
    page: pageSchema.optional(),
  }),
});

interface PageMetadata {
  readonly limit: number;
  readonly offset: number;
  readonly returned: number;
  readonly total: number;
  readonly next_offset: number | null;
}

export interface ToolPayload {
  readonly data: unknown;
  readonly summary: string;
  readonly page?: PageMetadata;
  readonly change?: {
    readonly id: string;
    readonly affectedCount: number;
    readonly reversible: boolean;
  };
}

export interface ToolHints {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export const READ_ONLY: ToolHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const UPDATE: ToolHints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const ACTION: ToolHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const CREATE: ToolHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const REMOVE: ToolHints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

interface ToolSpec<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<Shape>;
  readonly hints: ToolHints;
}

export function addTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  handler: (args: z.output<z.ZodObject<Shape>>) => Promise<ToolPayload>,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: toolOutputSchema,
      annotations: spec.hints,
    },
    async (args) => {
      const startedAt = performance.now();
      try {
        const result = await handler(args);
        const output = {
          data: result.data,
          meta: {
            source: 'monarch' as const,
            retrieved_at: new Date().toISOString(),
            ...(result.page ? { page: result.page } : {}),
          },
        };
        const response = {
          content: [
            {
              type: 'text' as const,
              text: result.summary,
            },
          ],
          structuredContent: output,
        };
        emitToolEvent({
          tool: spec.name,
          outcome: 'success',
          durationMs: performance.now() - startedAt,
          readOnly: spec.hints.readOnlyHint,
          destructive: spec.hints.destructiveHint,
          idempotent: spec.hints.idempotentHint,
          ...(result.change
            ? {
                changeId: result.change.id,
                affectedCount: result.change.affectedCount,
                reversible: result.change.reversible,
              }
            : {}),
        });
        return response;
      } catch (error) {
        emitToolEvent({
          tool: spec.name,
          outcome: 'error',
          durationMs: performance.now() - startedAt,
          readOnly: spec.hints.readOnlyHint,
          destructive: spec.hints.destructiveHint,
          idempotent: spec.hints.idempotentHint,
          errorKind: classifyError(error),
        });
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Monarch request failed: ${message}` }],
          isError: true as const,
        };
      }
    },
  );
}
