import { matchesRule, type ParsedItemForRules } from '../src/services/autoCommitEngine.js';

const baseRule = {
  enabled: true,
  minConfidence: 0.85,
};

describe('matchesRule', () => {
  it('rejects when rule is disabled', () => {
    const item: ParsedItemForRules = { amount: 10, type: 'expense', confidence: 0.95, description: 'Starbucks coffee' };
    expect(matchesRule(item, { ...baseRule, enabled: false })).toBe(false);
  });

  it('rejects when amount exceeds maxAmount', () => {
    const item: ParsedItemForRules = { amount: 200, type: 'expense', confidence: 0.95 };
    expect(matchesRule(item, { ...baseRule, maxAmount: 100 })).toBe(false);
  });

  it('rejects when confidence is below threshold', () => {
    const item: ParsedItemForRules = { amount: 10, type: 'expense', confidence: 0.5 };
    expect(matchesRule(item, { ...baseRule, minConfidence: 0.85 })).toBe(false);
  });

  it('rejects when type does not match', () => {
    const item: ParsedItemForRules = { amount: 10, type: 'income', confidence: 0.95 };
    expect(matchesRule(item, { ...baseRule, type: 'expense' })).toBe(false);
  });

  it('rejects when vendor pattern does not match description', () => {
    const item: ParsedItemForRules = { amount: 10, type: 'expense', confidence: 0.95, description: 'Uber trip' };
    expect(matchesRule(item, { ...baseRule, vendorPattern: 'starbucks' })).toBe(false);
  });

  it('rejects when category not in allow-list', () => {
    const item: ParsedItemForRules = { amount: 10, type: 'expense', confidence: 0.95, category: 'Travel' };
    expect(matchesRule(item, { ...baseRule, categories: ['Office Supplies', 'Marketing'] })).toBe(false);
  });

  it('matches a coffee-under-$20 rule', () => {
    const item: ParsedItemForRules = {
      amount: 12.5,
      type: 'expense',
      confidence: 0.95,
      description: 'STARBUCKS #1234 NYC',
      category: 'Meals',
    };
    expect(
      matchesRule(item, {
        ...baseRule,
        type: 'expense',
        vendorPattern: 'starbucks',
        maxAmount: 20,
        minConfidence: 0.85,
      }),
    ).toBe(true);
  });

  it('treats missing confidence as 0', () => {
    const item: ParsedItemForRules = { amount: 10, type: 'expense' };
    expect(matchesRule(item, { ...baseRule, minConfidence: 0.5 })).toBe(false);
  });

  it('handles zero-confidence threshold', () => {
    const item: ParsedItemForRules = { amount: 10, type: 'expense', confidence: 0 };
    expect(matchesRule(item, { ...baseRule, minConfidence: 0 })).toBe(true);
  });
});
