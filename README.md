# Monarch MCP

A small TypeScript MCP server for Monarch Money. Its TypeScript Monarch client
is pinned to a tested fork so upstream GraphQL changes can be fixed and verified
without waiting for an npm release.

The server uses the stable MCP TypeScript SDK v2 and serves both the modern
`2026-07-28` protocol and older MCP clients over stdio. Every successful call
returns concise text plus a schema-declared `structuredContent` envelope; clients
read the envelope for the data rather than parsing the text. Paginated calls expose
`total`, `returned`, and `next_offset`; compact records always keep their IDs.

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

- `MONARCH_SESSION_DIR` — token-cache directory; defaults to `~/.monarch-mcp`
- `MONARCH_TIMEOUT_SECONDS` — upstream request timeout; defaults to `30`
- `MONARCH_MCP_EVENT_LOG` — optional JSONL path for privacy-safe tool outcome and latency events
- `MONARCH_CHANGE_DIR` — durable change journal; defaults to `MONARCH_SESSION_DIR/changes`

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
- `upload_account_balance_history` — import CSV balances for a manual account

### Transactions

- `get_transactions` — complete filters, including review state, and explicit offset pagination
- `get_transactions_summary` — aggregate totals, averages, counts, and date bounds
- `get_transaction`, `get_transaction_splits`
- `get_transaction_categories`, `get_transaction_category_groups`
- `get_transaction_tags`
- `create_transaction`, `update_transaction`, `bulk_update_transactions`, `delete_transaction`
- `set_transaction_splits`, `set_transaction_tags`
- `create_transaction_tag`, `delete_transaction_tag`
- `create_transaction_category`, `delete_transaction_category`
- `get_transaction_rules`, `preview_transaction_rule`
- `create_transaction_rule`, `update_transaction_rule`, `delete_transaction_rule`

### Planning

- `get_budgets`, `get_goals`, `set_budget_amount`
- `get_cashflow`, `get_cashflow_summary`
- `get_recurring_transactions`, `update_recurring_merchant`

### Change history

- `get_change_history` — inspect change IDs, affected counts, status, and saved inverse operations
- `undo_change` — idempotently reverse a journaled change; this is not a redo facility

Transaction edits, bulk review work, recurring corrections, and rule changes are
journaled before the upstream write as atomic mode-0600 records. The local
`chg_<UUID>` identifies that private record; it is not a Monarch object ID.
Completed results include their `change_id` and affected count, and ambiguous
responses retain an `uncertain` journal entry. Before undo, state guards detect
newer edits and require `force=true` rather than silently overwriting them.
Retroactive rule application snapshots matching transactions before the rule
runs, including their tags and splits. If Monarch's reported applied count
differs from the previewed set, the change is explicitly marked as requiring
manual review rather than claiming an unsafe automatic undo.

`get_transactions` provides the client's paged and all-transactions behavior
without an unbounded MCP result. `delete_transaction_category` provides the
client's single and batch-helper behavior one exact result at a time.
Authentication, session, and timeout methods remain server internals.

Mutation tools are not hidden behind a server-specific flag. Their MCP
annotations accurately distinguish reads, updates, creates, and deletes so the
host can apply its normal interaction policy without making the toolset less
useful.

Account refreshes, bulk transaction updates, retroactive rules, and undo emit
standard MCP progress notifications. Standard cancellation stops work before a
write when possible, bounds already-started transaction writes to the existing
concurrency limit, and records the exact attempted set. If Monarch has already
accepted a retroactive rule, the server finishes its recovery journal before
stopping so a disconnected caller cannot leave an untracked change.

## Development

```bash
make check
```

The check runs formatting, lint, strict type checking, exact handler-contract
tests for every tool, and a production build. A separate self-cleaning live
suite validates the same surface against Monarch because CI has no account
credentials.

## Status

Monarch does not currently provide a supported public API for this integration.
The MCP is therefore an intentionally replaceable adapter around Monarch's web
API. It is not affiliated with or endorsed by Monarch Money.

## License

MIT
