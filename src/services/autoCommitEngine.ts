import AutoCommitRule, { type IAutoCommitRule } from '../models/AutoCommitRule.js';

export interface ParsedItemForRules {
  amount: number;
  type: 'income' | 'expense' | 'unassigned';
  category?: string | undefined;
  description?: string | undefined;
  confidence?: number | undefined;
}

export interface AutoCommitDecision {
  autoCommit: boolean;
  rule?: IAutoCommitRule;
  finalCategory?: string;
  reason?: string;
}

export const matchesRule = (item: ParsedItemForRules, rule: Pick<IAutoCommitRule, 'enabled' | 'type' | 'maxAmount' | 'minConfidence' | 'vendorPattern' | 'categories'>): boolean => {
  if (!rule.enabled) return false;

  if (rule.type && item.type !== rule.type) return false;

  if (typeof rule.maxAmount === 'number' && item.amount > rule.maxAmount) return false;

  if (typeof rule.minConfidence === 'number') {
    const c = item.confidence ?? 0;
    if (c < rule.minConfidence) return false;
  }

  if (rule.vendorPattern) {
    const haystack = (item.description || '').toLowerCase();
    if (!haystack.includes(rule.vendorPattern.toLowerCase())) return false;
  }

  if (rule.categories && rule.categories.length > 0) {
    const cat = (item.category || '').toLowerCase();
    const allowed = rule.categories.map((c) => c.toLowerCase());
    if (!allowed.includes(cat)) return false;
  }

  return true;
};

export const loadRules = (businessId: string) =>
  AutoCommitRule.find({ businessId, enabled: true }).sort({ createdAt: 1 });

export const evaluateItemWithRules = (
  item: ParsedItemForRules,
  rules: IAutoCommitRule[],
): AutoCommitDecision => {
  if (item.type === 'unassigned') {
    return { autoCommit: false, reason: 'Item type is unassigned' };
  }
  for (const rule of rules) {
    if (matchesRule(item, rule)) {
      const finalCategory = rule.defaultCategory || item.category || 'Uncategorized';
      return { autoCommit: true, rule, finalCategory };
    }
  }
  return { autoCommit: false, reason: 'No matching rule' };
};

export const evaluateItem = async (
  businessId: string,
  item: ParsedItemForRules,
): Promise<AutoCommitDecision> => {
  const rules = await loadRules(businessId);
  return evaluateItemWithRules(item, rules);
};

export const recordRuleHit = async (ruleId: string) => {
  try {
    await AutoCommitRule.updateOne(
      { _id: ruleId },
      { $inc: { matchCount: 1 }, $set: { lastMatchedAt: new Date() } },
    );
  } catch (err) {
    console.error('[AutoCommit] Failed to record rule hit:', err);
  }
};
