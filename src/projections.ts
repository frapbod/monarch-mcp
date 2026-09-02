import type { Account, Transaction } from '@hakimelek/monarchmoney';

export function compactAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    name: account.displayName,
    mask: account.mask,
    balance: account.currentBalance,
    display_balance: account.displayBalance,
    type: { name: account.type.name, display: account.type.display },
    subtype: { name: account.subtype.name, display: account.subtype.display },
    institution: account.institution
      ? { id: account.institution.id, name: account.institution.name }
      : null,
    credential_id: account.credential?.id ?? null,
    connection_status: account.credential?.institution.status ?? null,
    update_required: account.credential?.updateRequired ?? false,
    last_updated_at: account.displayLastUpdatedAt,
    include_in_net_worth: account.includeInNetWorth,
    hidden: account.isHidden || account.hideFromList,
    manual: account.isManual,
  };
}

export function compactTransaction(transaction: Transaction): Record<string, unknown> {
  return {
    id: transaction.id,
    date: transaction.date,
    amount: transaction.amount,
    merchant: transaction.merchant
      ? { id: transaction.merchant.id, name: transaction.merchant.name }
      : null,
    category: transaction.category
      ? { id: transaction.category.id, name: transaction.category.name }
      : null,
    account: {
      id: transaction.account.id,
      name: transaction.account.displayName,
    },
    notes: transaction.notes,
    pending: transaction.pending,
    needs_review: transaction.needsReview,
    review_status: transaction.reviewStatus,
    hidden_from_reports: transaction.hideFromReports,
    recurring: transaction.isRecurring,
    split: transaction.isSplitTransaction,
    tags: transaction.tags.map((tag) => ({ id: tag.id, name: tag.name })),
  };
}
