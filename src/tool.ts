import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const detailSchema = z
  .enum(['compact', 'full'])
  .default('compact')
  .describe('compact keeps useful fields and every record ID; full returns the upstream payload');

const pageSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
});

export const toolOutputSchema = z.object({
  data: z.unknown(),
  meta: z.object({
    source: z.literal('monarch'),
    retrieved_at: z.iso.datetime(),
    page: pageSchema.optional(),
  }),
});

export interface PageMetadata {
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `${result.summary}\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Monarch request failed: ${message}` }],
          isError: true as const,
        };
      }
    },
  );
}
