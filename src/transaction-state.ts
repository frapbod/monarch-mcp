import type { RecurringMerchantUpdate } from '@hakimelek/monarchmoney';

import type { TransactionGuard, TransactionValues, UndoStep } from './changes.js';

export function transactionFromDetails(data: Record<string, unknown>): Record<string, unknown> {
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

export function transactionUndoStep(details: Record<string, unknown>): UndoStep {
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
  const transaction = transactionFromDetails(details);
  const merchant = transaction.merchant as
    | { recurringTransactionStream?: Record<string, unknown> | null }
    | undefined;
  const stream = merchant?.recurringTransactionStream;
  if (!expected.isRecurring) return stream === null;
  if (!stream) return false;
  return Object.entries(expected).every(
    ([key, value]) => ['isRecurring', 'merchantId', 'name'].includes(key) || stream[key] === value,
  );
}
