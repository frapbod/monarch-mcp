import { RequestFailedException } from '@hakimelek/monarchmoney';

import type { MonarchClient } from './session.js';

// Monarch's web "Refresh all" sends one forceRefreshAllAccounts mutation and
// tracks the returned operation. The vendored client only offers the
// per-account forceRefreshAccount mutation, which Monarch answers with
// TOO_MANY_REQUESTS when it is sent once per account.
const REFRESH_ALL = `
  mutation Common_ForceRefreshAccountsMutation($input: ForceRefreshAllAccountsInput) {
    forceRefreshAllAccounts(input: $input) {
      success
      forceRefreshOperationId
      errors { fieldErrors { field messages } message code }
    }
  }
`;

const OPERATION = `
  query Common_ForceRefreshOperationQuery($id: ID!) {
    forceRefreshOperation(id: $id) {
      id
      state
      completedAccountCount
      totalAccountCount
      accounts { accountId state timedOut errorMessage }
    }
  }
`;

const LATEST_OPERATION = `
  query Common_LatestForceRefreshOperation {
    latestForceRefreshOperation { id state }
  }
`;

export interface RefreshOperation {
  readonly id: string;
  readonly state: string;
  readonly completedAccountCount: number;
  readonly totalAccountCount: number;
  readonly accounts: ReadonlyArray<{
    readonly accountId: string;
    readonly state: string;
    readonly timedOut: boolean | null;
    readonly errorMessage: string | null;
  }>;
}

interface PayloadError {
  readonly message?: string | null;
  readonly code?: string | null;
}

interface GraphQLClient {
  gqlCall<T>(operation: string, query: string, variables?: Record<string, unknown>): Promise<T>;
}

// gqlCall is private in the client's typings, but it is the client's only
// authenticated, rate-limited and retrying GraphQL path; the client is pinned.
function graphql(client: MonarchClient): GraphQLClient {
  return client as unknown as GraphQLClient;
}

/**
 * Monarch's code when it explicitly refused a request (HTTP 429, a GraphQL
 * error, or an error payload), or null when the outcome is unknown: network
 * failures and other HTTP statuses may have reached Monarch and are rethrown.
 */
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof RequestFailedException)) return null;
  if (error.statusCode === 429) return 'TOO_MANY_REQUESTS';
  if (error.statusCode !== undefined) return null;
  const graphQLErrors = error.graphQLErrors as
    | Array<{ extensions?: { code?: string | null } }>
    | undefined;
  const code = graphQLErrors?.find((item) => item.extensions?.code)?.extensions?.code;
  if (code) return code;
  return /"code":"([A-Z_]+)"/.exec(error.message)?.[1] ?? 'REFUSED';
}

/**
 * Starts Monarch's refresh of every account. Returns its operation ID, or null
 * when Monarch accepted the refresh without one (its web client allows that).
 */
export async function requestRefreshAll(client: MonarchClient): Promise<string | null> {
  const result = await graphql(client).gqlCall<{
    forceRefreshAllAccounts: {
      success: boolean;
      forceRefreshOperationId: string | null;
      errors: PayloadError | null;
    } | null;
  }>('Common_ForceRefreshAccountsMutation', REFRESH_ALL, { input: {} });
  const payload = result.forceRefreshAllAccounts;
  const error = payload?.errors;
  if (!payload?.success || error?.code || error?.message) {
    // Same message shape as the client's per-account payload errors, so
    // refusalCode reads the code from it.
    throw new RequestFailedException(
      `Monarch did not start the refresh: ${JSON.stringify(error ?? { success: false })}`,
    );
  }
  return payload.forceRefreshOperationId ?? null;
}

export async function getRefreshOperation(
  client: MonarchClient,
  id: string,
): Promise<RefreshOperation | null> {
  const result = await graphql(client).gqlCall<{ forceRefreshOperation: RefreshOperation | null }>(
    'Common_ForceRefreshOperationQuery',
    OPERATION,
    { id },
  );
  return result.forceRefreshOperation;
}

export async function getLatestRefreshOperationId(client: MonarchClient): Promise<string | null> {
  const result = await graphql(client).gqlCall<{
    latestForceRefreshOperation: { id: string } | null;
  }>('Common_LatestForceRefreshOperation', LATEST_OPERATION);
  return result.latestForceRefreshOperation?.id ?? null;
}

/** Compact operation view: counts by state plus every account ID with its state. */
export function compactOperation(operation: RefreshOperation) {
  const accountStates: Record<string, number> = {};
  for (const account of operation.accounts) {
    accountStates[account.state] = (accountStates[account.state] ?? 0) + 1;
  }
  return {
    operation_id: operation.id,
    state: operation.state,
    complete: operation.state === 'COMPLETED',
    completed_accounts: operation.completedAccountCount,
    total_accounts: operation.totalAccountCount,
    account_states: accountStates,
    accounts: operation.accounts.map((account) => ({
      account_id: account.accountId,
      state: account.state,
      timed_out: account.timedOut ?? false,
      error_message: account.errorMessage ?? null,
    })),
  };
}
