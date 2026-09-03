import type { RecurringMerchantUpdate } from '@hakimelek/monarchmoney';

import type { ChangeStep, TransactionGuard, TransactionValues } from './changes.js';

function transactionFromDetails(data: Record<string, unknown>): Record<string, unknown> {
  const transaction = data.transaction;
  if (!transaction || typeof transaction !== 'object') {
    throw new Error('Monarch returned no transaction details');
  }
  return transaction as Record<string, unknown>;
}

export function transactionValues(data: Record<string, unknown>): TransactionValues {
  const transaction = transactionFromDetails(data);
  const category = transaction.category as { id?: string } | null;
  const merchant = transaction.merchant as { name?: string } | null;
  return {
    ...(category?.id ? { categoryId: category.id } : {}),
    ...(merchant?.name ? { merchantName: merchant.name } : {}),
    goalId: (transaction.goal as { id?: string } | null)?.id ?? '',
    ...(typeof transaction.amount === 'number' ? { amount: transaction.amount } : {}),
    ...(typeof transaction.date === 'string' ? { date: transaction.date } : {}),
    notes: (transaction.notes as string | null | undefined) ?? '',
    ...(typeof transaction.hideFromReports === 'boolean'
      ? { hideFromReports: transaction.hideFromReports }
      : {}),
    ...(typeof transaction.needsReview === 'boolean'
      ? { needsReview: transaction.needsReview }
      : {}),
  };
}

export function transactionTagIds(data: Record<string, unknown>): string[] {
  const transaction = transactionFromDetails(data);
  return (transaction.tags as Array<{ id: string }> | undefined)?.map(({ id }) => id) ?? [];
}

export function transactionSplitValues(data: Record<string, unknown>): Array<{
  merchantName: string;
  amount: number;
  categoryId: string;
}> {
  const splits = transactionFromDetails(data).splitTransactions;
  if (!Array.isArray(splits)) return [];
  return splits.map((value) => {
    const split = value as Record<string, unknown>;
    return {
      merchantName: (split.merchant as { name: string }).name,
      amount: split.amount as number,
      categoryId: (split.category as { id: string }).id,
    };
  });
}

export function transactionUndoStep(details: Record<string, unknown>): ChangeStep {
  const transaction = transactionFromDetails(details);
  const id = transaction.id as string;
  return {
    operation: 'restore_transaction',
    id,
    values: transactionValues(details),
    tagIds: transactionTagIds(details),
    splits: transactionSplitValues(details),
  };
}

export function transactionGuard(details: Record<string, unknown>): TransactionGuard {
  const transaction = transactionFromDetails(details);
  return {
    kind: 'transaction',
    id: transaction.id as string,
    values: transactionValues(details),
    tagIds: transactionTagIds(details),
    splits: transactionSplitValues(details),
  };
}

export function recurringMatches(
  details: Record<string, unknown>,
  expected: RecurringMerchantUpdate,
): boolean {
  const actual = recurringValues(details);
  if (actual.isRecurring !== expected.isRecurring) return false;
  return Object.entries(expected).every(
    ([key, value]) =>
      ['merchantId', 'name'].includes(key) || actual[key as keyof typeof actual] === value,
  );
}

export function recurringValues(details: Record<string, unknown>): RecurringMerchantUpdate {
  const transaction = transactionFromDetails(details);
  const merchant = transaction.merchant as
    | { id?: string; name?: string; recurringTransactionStream?: Record<string, unknown> | null }
    | undefined;
  if (!merchant?.id || !merchant.name) throw new Error('Transaction has no recurring merchant');
  const stream = merchant?.recurringTransactionStream;
  return {
    merchantId: merchant.id,
    name: merchant.name,
    isRecurring: Boolean(stream),
    ...(typeof stream?.frequency === 'string' ? { frequency: stream.frequency } : {}),
    ...(typeof stream?.baseDate === 'string' ? { baseDate: stream.baseDate } : {}),
    ...(typeof stream?.amount === 'number' ? { amount: stream.amount } : {}),
    ...(typeof stream?.isActive === 'boolean' ? { isActive: stream.isActive } : {}),
  };
}
