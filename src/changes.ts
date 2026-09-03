import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  RecurringMerchantUpdate,
  TransactionRuleInput,
  TransactionRuleUpdate,
} from '@hakimelek/monarchmoney';

export interface TransactionValues {
  readonly categoryId?: string;
  readonly merchantName?: string;
  readonly goalId?: string;
  readonly amount?: number;
  readonly date?: string;
  readonly notes?: string;
  readonly hideFromReports?: boolean;
  readonly needsReview?: boolean;
}

export interface AccountValues {
  readonly accountName?: string;
  readonly accountBalance?: number;
  readonly accountType?: string;
  readonly accountSubType?: string;
  readonly includeInNetWorth?: boolean;
  readonly hideFromSummaryList?: boolean;
  readonly hideTransactionsFromReports?: boolean;
}

interface BudgetValues {
  readonly amount: number;
  readonly categoryId?: string;
  readonly categoryGroupId?: string;
  readonly startDate?: string;
  readonly applyToFuture?: boolean;
}

export interface TransactionGuard {
  readonly kind: 'transaction';
  readonly id: string;
  readonly values?: TransactionValues;
  readonly tagIds?: string[];
  readonly splits?: Array<{ merchantName: string; amount: number; categoryId: string }>;
}

export type ChangeGuard =
  | TransactionGuard
  | { readonly kind: 'account'; readonly id: string; readonly values: AccountValues }
  | {
      readonly kind: 'recurring';
      readonly transactionId: string;
      readonly values: RecurringMerchantUpdate;
    }
  | {
      readonly kind: 'rule';
      readonly id: string;
      readonly value: TransactionRuleInput;
      readonly recentApplicationCount?: number;
      readonly lastAppliedAt?: string | null;
    }
  | {
      readonly kind: 'rule_update';
      readonly id: string;
      readonly values: TransactionRuleUpdate;
    }
  | {
      readonly kind: 'tag';
      readonly id: string;
      readonly name: string;
      readonly color: string;
    }
  | {
      readonly kind: 'category';
      readonly id: string;
      readonly name: string;
      readonly groupId: string;
    }
  | { readonly kind: 'budget'; readonly values: BudgetValues };

export type ChangeStep =
  | {
      readonly operation: 'update_transaction';
      readonly id: string;
      readonly values: TransactionValues;
    }
  | { readonly operation: 'set_transaction_tags'; readonly id: string; readonly tagIds: string[] }
  | {
      readonly operation: 'set_transaction_splits';
      readonly id: string;
      readonly splits: Array<{ merchantName: string; amount: number; categoryId: string }>;
    }
  | {
      readonly operation: 'restore_transaction';
      readonly id: string;
      readonly values: TransactionValues;
      readonly tagIds: string[];
      readonly splits: Array<{ merchantName: string; amount: number; categoryId: string }>;
    }
  | { readonly operation: 'delete_transaction_rule'; readonly id: string }
  | {
      readonly operation: 'update_transaction_rule';
      readonly id: string;
      readonly values: TransactionRuleUpdate;
    }
  | { readonly operation: 'create_transaction_rule'; readonly values: TransactionRuleInput }
  | {
      readonly operation: 'update_recurring_merchant';
      readonly transactionId?: string;
      readonly values: RecurringMerchantUpdate;
    }
  | { readonly operation: 'delete_account'; readonly id: string }
  | { readonly operation: 'update_account'; readonly id: string; readonly values: AccountValues }
  | { readonly operation: 'delete_transaction'; readonly id: string }
  | { readonly operation: 'delete_transaction_tag'; readonly id: string }
  | { readonly operation: 'delete_transaction_category'; readonly id: string }
  | { readonly operation: 'set_budget_amount'; readonly values: BudgetValues };

export interface ChangeRecord {
  readonly id: string;
  readonly tool: string;
  readonly created_at: string;
  readonly affected_count: number;
  readonly reversible: boolean;
  readonly reversibility_reason?: string;
  readonly undo: ChangeStep[];
  readonly redo?: ChangeStep[];
  readonly guards?: ChangeGuard[];
  readonly redo_guards?: ChangeGuard[];
  readonly snapshot?: unknown;
  readonly status: 'prepared' | 'active' | 'undoing' | 'redoing' | 'uncertain' | 'undone';
  readonly activated_at?: string;
  readonly undo_started_at?: string;
  readonly redo_started_at?: string;
  readonly uncertain_at?: string;
  readonly undone_at?: string;
  readonly redone_at?: string;
}

type ChangeInput = Omit<
  ChangeRecord,
  | 'id'
  | 'created_at'
  | 'status'
  | 'activated_at'
  | 'undo_started_at'
  | 'redo_started_at'
  | 'uncertain_at'
  | 'undone_at'
  | 'redone_at'
>;

interface ChangeCompletion {
  readonly affected_count?: number;
  readonly reversible?: boolean;
  readonly reversibility_reason?: string | null;
  readonly undo?: ChangeStep[];
  readonly redo?: ChangeStep[];
  readonly guards?: ChangeGuard[];
  readonly snapshot?: unknown;
}

export interface ChangeStore {
  prepare(input: ChangeInput): ChangeRecord;
  activate(id: string, completion?: ChangeCompletion): ChangeRecord;
  markUncertain(id: string): ChangeRecord;
  markUndoing(id: string): ChangeRecord;
  markRedoing(id: string): ChangeRecord;
  get(id: string): ChangeRecord | undefined;
  list(limit: number): ChangeRecord[];
  markUndone(id: string, redoGuards?: ChangeGuard[]): ChangeRecord;
  markRedone(id: string, guards?: ChangeGuard[]): ChangeRecord;
}

export async function journalMutation<T>(
  changes: ChangeStore,
  input: ChangeInput,
  mutate: () => Promise<T>,
  complete: (value: T) => ChangeCompletion = () => ({}),
): Promise<{ value: T; change: ChangeRecord }> {
  const prepared = changes.prepare(input);
  const value = await performPrepared(changes, prepared.id, mutate);
  let completion: ChangeCompletion;
  try {
    completion = complete(value);
  } catch (error) {
    tryMarkUncertain(changes, prepared.id);
    throw uncertainMutationError(prepared.id, error);
  }
  return { value, change: activatePrepared(changes, prepared.id, completion) };
}

export function activatePrepared(
  changes: ChangeStore,
  changeId: string,
  completion: ChangeCompletion = {},
): ChangeRecord {
  try {
    return changes.activate(changeId, completion);
  } catch (error) {
    tryMarkUncertain(changes, changeId);
    throw uncertainMutationError(changeId, error);
  }
}

export async function performPrepared<T>(
  changes: ChangeStore,
  changeId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  try {
    return await mutate();
  } catch (error) {
    tryMarkUncertain(changes, changeId);
    throw uncertainMutationError(changeId, error);
  }
}

export function tryMarkUncertain(changes: ChangeStore, changeId: string): void {
  try {
    changes.markUncertain(changeId);
  } catch {}
}

export function selectedValues<Values extends object>(actual: Values, selected: Values): Values {
  return Object.fromEntries(
    Object.keys(selected).map((key) => [key, actual[key as keyof Values]]),
  ) as Values;
}

export function selectedValuesMatch<Values extends object>(
  actual: Values,
  expected: Partial<Values>,
): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key as keyof Values] === value);
}

export async function observeMutationOutcome<Result, Guard>(
  mutate: () => Promise<Result>,
  observe: () => Promise<{ verified: boolean; guard: Guard }>,
) {
  let result: Result | undefined;
  let writeError: string | undefined;
  try {
    result = await mutate();
  } catch (error) {
    writeError = error instanceof Error ? error.message : String(error);
  }
  try {
    return {
      result,
      ...(await observe()),
      ...(writeError !== undefined ? { writeError } : {}),
    };
  } catch {
    return {
      result,
      verified: false,
      guard: undefined,
      ...(writeError !== undefined ? { writeError } : {}),
    };
  }
}

function uncertainMutationError(changeId: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Mutation outcome is uncertain; inspect change ${changeId}: ${message}`, {
    cause,
  });
}

function defaultChangeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const sessionDirectory =
    env.MONARCH_SESSION_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.monarch-mcp');
  return env.MONARCH_CHANGE_DIR?.trim() || join(sessionDirectory, 'changes');
}

export class FileChangeStore implements ChangeStore {
  constructor(private readonly directory = defaultChangeDirectory()) {}

  prepare(input: ChangeInput): ChangeRecord {
    const record: ChangeRecord = {
      ...input,
      id: `chg_${randomUUID()}`,
      created_at: new Date().toISOString(),
      status: 'prepared',
    };
    this.write(record);
    return record;
  }

  activate(id: string, completion: ChangeCompletion = {}): ChangeRecord {
    const current = this.required(id);
    const { reversibility_reason: reason, ...rest } = completion;
    const merged = { ...current, ...rest };
    const { reversibility_reason: _oldReason, ...withoutReason } = merged;
    const updated: ChangeRecord = {
      ...(reason === null ? withoutReason : merged),
      ...(typeof reason === 'string' ? { reversibility_reason: reason } : {}),
      status: 'active',
      activated_at: current.activated_at ?? new Date().toISOString(),
    };
    this.write(updated);
    return updated;
  }

  markUncertain(id: string): ChangeRecord {
    return this.update(id, (current) => ({
      status: 'uncertain',
      uncertain_at: current.uncertain_at ?? new Date().toISOString(),
    }));
  }

  markUndoing(id: string): ChangeRecord {
    return this.update(id, () => ({
      status: 'undoing',
      undo_started_at: new Date().toISOString(),
    }));
  }

  markRedoing(id: string): ChangeRecord {
    return this.update(id, () => ({
      status: 'redoing',
      redo_started_at: new Date().toISOString(),
    }));
  }

  get(id: string): ChangeRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.path(id), 'utf8')) as ChangeRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw error;
    }
  }

  list(limit: number): ChangeRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
    return names
      .map((name) => this.get(name.slice(0, -5)))
      .filter((record): record is ChangeRecord => record !== undefined)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit);
  }

  markUndone(id: string, redoGuards?: ChangeGuard[]): ChangeRecord {
    return this.update(id, () => ({
      ...(redoGuards ? { redo_guards: redoGuards } : {}),
      status: 'undone',
      undone_at: new Date().toISOString(),
    }));
  }

  markRedone(id: string, guards?: ChangeGuard[]): ChangeRecord {
    return this.update(id, () => ({
      ...(guards ? { guards } : {}),
      status: 'active',
      redone_at: new Date().toISOString(),
    }));
  }

  private update(
    id: string,
    values: (current: ChangeRecord) => Partial<ChangeRecord>,
  ): ChangeRecord {
    const current = this.required(id);
    const updated = { ...current, ...values(current) };
    this.write(updated);
    return updated;
  }

  private required(id: string): ChangeRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Change ${id} was not found`);
    return record;
  }

  private path(id: string): string {
    if (!/^chg_[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid change ID ${id}`);
    return join(this.directory, `${id}.json`);
  }

  private write(record: ChangeRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const file = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const directory = openSync(this.directory, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
