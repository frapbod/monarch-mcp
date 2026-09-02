# Monarch MCP

A small, first-party TypeScript MCP server for Monarch Money. It presents the
unofficial Monarch API as predictable agent tools instead of leaking a raw
GraphQL surface or inheriting another server's output quirks.

The server uses the stable MCP TypeScript SDK v2 and serves both the modern
`2026-07-28` protocol and older MCP clients over stdio. Every successful call
returns concise text plus validated `structuredContent`. Paginated calls expose
`total`, `returned`, and `next_offset`; compact records always keep their IDs.

## What it combines

- the maintained TypeScript Monarch client and its broad API coverage;
- compact but evidence-complete results inspired by `jamiew/monarch-mcp`;
- the broad read and bookkeeping surface found in `robcerda/monarch-mcp-server`;
- explicit schemas, tests, and mutation clarity found in
  `vargahis/monarch-mcp-server`;
- MCP v2 tool schemas, structured output, annotations, and dual-era stdio from
  the official TypeScript SDK.

Only `@hakimelek/monarchmoney` is a runtime Monarch dependency. The other
projects informed the interface; their server code is not vendored.

## Run

Node 22 is pinned in `.node-version` and `versions.env`.

```bash
npm ci
npm run build
MONARCH_EMAIL='you@example.com' \
MONARCH_PASSWORD='...' \
MONARCH_MFA_SECRET='BASE32_TOTP_SECRET' \
node dist/server.js
```

`MONARCH_TOKEN` can replace the three credential variables. Optional settings:

- `MONARCH_SESSION_DIR` — token-cache directory; defaults to `.mm`
- `MONARCH_TIMEOUT_SECONDS` — upstream request timeout; defaults to `30`

The image is built with `make image`; its stdio entrypoint is the server.

## Tool surface

### Accounts and institutions

- `get_accounts` — IDs, balances, types, institutions, connection state, freshness
- `get_account_holdings` — investment positions for an account
- `get_account_history` — complete available balance snapshots for an account
- `get_recent_account_balances` — balance arrays across accounts from a date
- `get_net_worth_history` — aggregate balance history
- `get_account_snapshots_by_type` — monthly or yearly balances by account type
- `get_account_type_options` — valid types/subtypes for manual accounts
- `get_institutions` — linked credentials and connection state
- `get_subscription` — plan and entitlement metadata
- `get_refresh_status` — whether a requested institution sync is still running
- `refresh_accounts` — start a sync and, by default, wait and re-read the accounts
- `create_manual_account`, `update_account`, `delete_account`

### Transactions

- `get_transactions` — complete filters and explicit offset pagination
- `get_transaction`, `get_transaction_splits`
- `get_transaction_categories`, `get_transaction_category_groups`
- `get_transaction_tags`
- `create_transaction`, `update_transaction`, `delete_transaction`
- `set_transaction_splits`, `set_transaction_tags`
- `create_transaction_tag`
- `create_transaction_category`, `delete_transaction_category`

### Planning

- `get_budgets`, `set_budget_amount`
- `get_cashflow`, `get_cashflow_summary`
- `get_recurring_transactions`

Mutation tools are not hidden behind a server-specific flag. Their MCP
annotations accurately distinguish reads, updates, creates, and deletes so the
host can apply its normal interaction policy without making the toolset less
useful.

## Development

```bash
make check
```

The check runs formatting, lint, strict type checking, behavior tests,
concurrent state tests, and a production build. Live Monarch integration checks
are performed during the Hermes image rollout because CI has no personal
account credentials.

## Status

Monarch does not currently provide a supported public API for this integration.
The MCP is therefore an intentionally replaceable adapter around Monarch's web
API. It is not affiliated with or endorsed by Monarch Money.

## License

MIT

