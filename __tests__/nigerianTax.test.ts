import {
  computePitTax,
  computeCRA,
  computeCapitalAllowance,
  inferTaxCategory,
  PIT_BANDS,
} from '../src/services/nigerianTax.js';

describe('computePitTax', () => {
  it('returns zero tax for zero or negative income', () => {
    expect(computePitTax(0).totalTax).toBe(0);
    expect(computePitTax(-1000).totalTax).toBe(0);
  });

  it('taxes only the first band when below ₦300k', () => {
    const r = computePitTax(200_000);
    expect(r.totalTax).toBeCloseTo(200_000 * 0.07);
    expect(r.breakdown).toHaveLength(1);
  });

  it('crosses bands cleanly at ₦600k', () => {
    const r = computePitTax(600_000);
    // 300k @ 7% + 300k @ 11%
    expect(r.totalTax).toBeCloseTo(300_000 * 0.07 + 300_000 * 0.11);
    expect(r.breakdown).toHaveLength(2);
  });

  it('applies the top band on incomes above ₦3.2m', () => {
    const r = computePitTax(5_000_000);
    const expected =
      300_000 * 0.07 +
      300_000 * 0.11 +
      500_000 * 0.15 +
      500_000 * 0.19 +
      1_600_000 * 0.21 +
      1_800_000 * 0.24;
    expect(r.totalTax).toBeCloseTo(expected);
  });

  it('breakdown amounts equal the input', () => {
    const income = 1_200_000;
    const r = computePitTax(income);
    const sum = r.breakdown.reduce((a, b) => a + b.amountInBand, 0);
    expect(sum).toBeCloseTo(income);
  });

  it('uses exactly six configured bands', () => {
    expect(PIT_BANDS).toHaveLength(6);
  });
});

describe('computeCRA', () => {
  it('returns zero for non-positive income', () => {
    expect(computeCRA(0)).toBe(0);
    expect(computeCRA(-100)).toBe(0);
  });

  it('uses ₦200k floor when 1% is smaller', () => {
    // 1m * 1% = 10k, floor 200k applies
    expect(computeCRA(1_000_000)).toBeCloseTo(200_000 + 1_000_000 * 0.2);
  });

  it('uses 1% when above the floor', () => {
    // 30m * 1% = 300k, beats 200k floor
    expect(computeCRA(30_000_000)).toBeCloseTo(30_000_000 * 0.01 + 30_000_000 * 0.2);
  });
});

describe('computeCapitalAllowance', () => {
  it('claims initial + first annual in year of acquisition', () => {
    const acquired = new Date(Date.UTC(2024, 5, 1));
    const result = computeCapitalAllowance(
      { cost: 1_000_000, assetClass: 'computer_equipment', acquiredOn: acquired },
      2024,
    );
    // Computer equipment: initial 50% + annual 25% = 750k in year 1
    expect(result).toBeCloseTo(750_000);
  });

  it('claims annual on TWDV in subsequent years', () => {
    const acquired = new Date(Date.UTC(2024, 0, 1));
    // Year 2025: cost 1m, initial 50% = 500k taken in Y1, plus 1 annual at 25% = 250k.
    // Y2 should claim min(twdv, annual). twdv after Y1 = 1m - 500k - 250k = 250k.
    // annual = 250k (1m * 25%). So Y2 = 250k.
    const result = computeCapitalAllowance(
      { cost: 1_000_000, assetClass: 'computer_equipment', acquiredOn: acquired },
      2025,
    );
    expect(result).toBeCloseTo(250_000);
  });

  it('returns zero before acquisition year', () => {
    const acquired = new Date(Date.UTC(2025, 0, 1));
    const result = computeCapitalAllowance(
      { cost: 1_000_000, assetClass: 'plant_machinery', acquiredOn: acquired },
      2024,
    );
    expect(result).toBe(0);
  });

  it('returns zero after disposal', () => {
    const result = computeCapitalAllowance(
      {
        cost: 1_000_000,
        assetClass: 'plant_machinery',
        acquiredOn: new Date(Date.UTC(2022, 0, 1)),
        disposedOn: new Date(Date.UTC(2023, 11, 31)),
      },
      2024,
    );
    expect(result).toBe(0);
  });

  it('does not over-claim once asset is fully written down', () => {
    const acquired = new Date(Date.UTC(2010, 0, 1));
    const result = computeCapitalAllowance(
      { cost: 100_000, assetClass: 'computer_equipment', acquiredOn: acquired },
      2024,
    );
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100_000);
  });
});

describe('inferTaxCategory', () => {
  it('maps rent expense', () => {
    expect(inferTaxCategory('Office rent payment', 'expense')).toBe('rent');
  });

  it('maps salary expense', () => {
    expect(inferTaxCategory('December staff salaries', 'expense')).toBe('salaries');
  });

  it('maps NEPA / utilities', () => {
    expect(inferTaxCategory('NEPA bill', 'expense')).toBe('utilities');
    expect(inferTaxCategory('Diesel for generator', 'expense')).toBe('utilities');
  });

  it('maps Uber to transport', () => {
    expect(inferTaxCategory('Uber to client meeting', 'expense')).toBe('transport');
  });

  it('flags entertainment as disallowed', () => {
    expect(inferTaxCategory('Client dinner entertainment', 'expense')).toBe('entertainment_disallowed');
  });

  it('flags donations as disallowed', () => {
    expect(inferTaxCategory('Church donation', 'expense')).toBe('donations_disallowed');
  });

  it('routes equipment to capital expenditure', () => {
    expect(inferTaxCategory('New laptop computer', 'expense')).toBe('capital_expenditure');
  });

  it('catches pension', () => {
    expect(inferTaxCategory('PenCom RSA contribution', 'expense')).toBe('pension_contributions');
  });

  it('defaults income to business income', () => {
    expect(inferTaxCategory('Project payment', 'income')).toBe('income_business');
    expect(inferTaxCategory(undefined, 'income')).toBe('income_business');
  });

  it('returns null for unmatched expense', () => {
    expect(inferTaxCategory('xyzzy something obscure', 'expense')).toBeNull();
  });
});
