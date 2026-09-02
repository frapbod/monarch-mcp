import type {
  TransactionRule,
  TransactionRuleInput,
  TransactionRuleUpdate,
} from '@hakimelek/monarchmoney';

export function ruleDefinition(input: TransactionRuleInput): TransactionRuleInput {
  const { applyToExistingTransactions: _apply, ...definition } = input;
  type Criteria = NonNullable<TransactionRuleInput['merchantCriteria']>;
  const normalizeCriteria = (criteria: Criteria): Criteria =>
    criteria.map((criterion) => ({
      ...criterion,
      value: criterion.value.toLocaleLowerCase(),
    }));
  return {
    merchantCriteriaUseOriginalStatement: false,
    setHideFromReportsAction: false,
    ...definition,
    ...(definition.merchantCriteria
      ? { merchantCriteria: normalizeCriteria(definition.merchantCriteria) }
      : {}),
    ...(definition.originalStatementCriteria
      ? { originalStatementCriteria: normalizeCriteria(definition.originalStatementCriteria) }
      : {}),
    ...(definition.merchantNameCriteria
      ? { merchantNameCriteria: normalizeCriteria(definition.merchantNameCriteria) }
      : {}),
  };
}

export function ruleInputFromApi(rule: TransactionRule): TransactionRuleInput {
  return ruleDefinition({
    ...(rule.merchantCriteriaUseOriginalStatement !== undefined
      ? { merchantCriteriaUseOriginalStatement: rule.merchantCriteriaUseOriginalStatement }
      : {}),
    ...(rule.merchantCriteria ? { merchantCriteria: rule.merchantCriteria } : {}),
    ...(rule.originalStatementCriteria
      ? { originalStatementCriteria: rule.originalStatementCriteria }
      : {}),
    ...(rule.merchantNameCriteria ? { merchantNameCriteria: rule.merchantNameCriteria } : {}),
    ...(rule.amountCriteria ? { amountCriteria: rule.amountCriteria } : {}),
    ...(rule.categoryIds ? { categoryIds: rule.categoryIds } : {}),
    ...(rule.accountIds ? { accountIds: rule.accountIds } : {}),
    ...(rule.setMerchantAction
      ? {
          setMerchantAction:
            typeof rule.setMerchantAction === 'string'
              ? rule.setMerchantAction
              : rule.setMerchantAction.name,
        }
      : {}),
    ...(rule.setCategoryAction
      ? {
          setCategoryAction:
            typeof rule.setCategoryAction === 'string'
              ? rule.setCategoryAction
              : rule.setCategoryAction.id,
        }
      : {}),
    ...(rule.addTagsAction
      ? {
          addTagsAction: rule.addTagsAction.map((tag) => (typeof tag === 'string' ? tag : tag.id)),
        }
      : {}),
    ...(rule.linkGoalAction
      ? {
          linkGoalAction:
            typeof rule.linkGoalAction === 'string' ? rule.linkGoalAction : rule.linkGoalAction.id,
        }
      : {}),
    ...(rule.reviewStatusAction ? { reviewStatusAction: rule.reviewStatusAction } : {}),
    ...(rule.setHideFromReportsAction !== undefined
      ? { setHideFromReportsAction: rule.setHideFromReportsAction }
      : {}),
    ...(rule.splitTransactionsAction
      ? { splitTransactionsAction: rule.splitTransactionsAction }
      : {}),
  });
}

export function ruleRestoreInput(rule: TransactionRule): TransactionRuleUpdate {
  const value = ruleInputFromApi(rule);
  return {
    merchantCriteriaUseOriginalStatement: value.merchantCriteriaUseOriginalStatement ?? false,
    merchantCriteria: value.merchantCriteria ?? [],
    originalStatementCriteria: value.originalStatementCriteria ?? [],
    merchantNameCriteria: value.merchantNameCriteria ?? [],
    amountCriteria: value.amountCriteria ?? null,
    categoryIds: value.categoryIds ?? [],
    accountIds: value.accountIds ?? [],
    setMerchantAction: value.setMerchantAction ?? null,
    setCategoryAction: value.setCategoryAction ?? null,
    addTagsAction: value.addTagsAction ?? [],
    linkGoalAction: value.linkGoalAction ?? null,
    reviewStatusAction: value.reviewStatusAction ?? null,
    setHideFromReportsAction: value.setHideFromReportsAction ?? false,
    splitTransactionsAction: value.splitTransactionsAction ?? null,
  };
}
