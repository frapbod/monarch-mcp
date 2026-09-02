export function budgetAmount(
  budgetData: Record<string, unknown>,
  kind: 'category' | 'category_group',
  id: string,
  month: string,
): number {
  const collection =
    kind === 'category'
      ? budgetData.monthlyAmountsByCategory
      : budgetData.monthlyAmountsByCategoryGroup;
  if (!Array.isArray(collection)) return 0;
  const ownerKey = kind === 'category' ? 'category' : 'categoryGroup';
  const entry = collection.find(
    (value) =>
      ((value as Record<string, unknown>)[ownerKey] as { id?: string } | undefined)?.id === id,
  ) as Record<string, unknown> | undefined;
  const amounts = entry?.monthlyAmounts;
  if (!Array.isArray(amounts)) return 0;
  const prior = amounts.find((value) => (value as Record<string, unknown>).month === month) as
    | Record<string, unknown>
    | undefined;
  return typeof prior?.plannedCashFlowAmount === 'number' ? prior.plannedCashFlowAmount : 0;
}
