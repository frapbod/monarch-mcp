# Monarch MCP Context

This repository contains a TypeScript MCP server for Monarch Money.

## Contract

- The default branch is `master`.
- `versions.env` is the human-readable version pin index; `package-lock.json`
  is the authoritative dependency graph.
- Keep the server on the current stable TypeScript MCP SDK and serve both the
  modern and legacy protocol eras through `serveStdio`.
- stdout is exclusively the MCP wire. Logs go to stderr.
- Tool results always include both concise text and schema-declared
  `structuredContent`; compact projections must retain record IDs.
- Read calls may retry transient failures. Mutations must not be replayed after
  an ambiguous upstream response.
- Add behavior tests for pagination, compact projections, tool annotations,
  refresh completion, and authentication coalescing.
- Run `make check` before committing. Commits require DCO signoff.

## Layout

- `src/session.ts`: authentication, session reuse, and read/write client policy
- `src/tool.ts`: one MCP result and error contract
- `src/tools/`: responsibility-focused tool registration
- `src/server.ts`: factory and stdio lifecycle only
