/**
 * Nigerian tax categories, rates, and computation helpers aligned to FIRS /
 * Personal Income Tax Act guidance.
 *
 * IMPORTANT: rates, bands and category lists below reflect widely-published
 * guidance valid through early 2025. Nigerian tax law is in active reform
 * (Tinubu Tax Reform Bills, 2024). DO NOT rely on outputs for filing without
 * validation from a licensed Nigerian Chartered Accountant.
 *
 * Sources used to seed this file: Personal Income Tax Act (CAP P8) as amended,
 * Companies Income Tax Act (CITA) Second Schedule for capital allowances,
 * Finance Acts 2019–2023.
 */

export type NigerianTaxCategory =
  | 'income_business'
  | 'income_other'
  | 'rent'
  | 'salaries'
  | 'utilities'
  | 'professional_fees'
  | 'repairs_maintenance'
  | 'transport'
  | 'advertising_marketing'
  | 'insurance'
  | 'bank_charges'
  | 'office_supplies'
  | 'subscriptions_software'
  | 'pension_contributions'
  | 'nhis'
  | 'life_assurance'
  | 'capital_expenditure'
  | 'entertainment_disallowed'
  | 'donations_disallowed'
  | 'fines_penalties'
  | 'owner_drawings'
  | 'private_expense'
  | 'other_allowable'
  | 'other_disallowable';

export interface CategoryMeta {
  label: string;
  isIncome: boolean;
  isAllowableDeduction: boolean;
  isReliefDeduction: boolean; // pension, NHIS, life assurance — exempt from PIT
  note?: string;
}

export const TAX_CATEGORY_META: Record<NigerianTaxCategory, CategoryMeta> = {
  income_business: { label: 'Business Income', isIncome: true, isAllowableDeduction: false, isReliefDeduction: false },
  income_other: { label: 'Other Income (interest, royalty, etc.)', isIncome: true, isAllowableDeduction: false, isReliefDeduction: false },

  rent: { label: 'Rent', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  salaries: { label: 'Salaries & Wages', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  utilities: { label: 'Utilities & Power', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  professional_fees: { label: 'Professional Fees', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  repairs_maintenance: { label: 'Repairs & Maintenance', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  transport: { label: 'Transport & Travel', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  advertising_marketing: { label: 'Advertising & Marketing', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  insurance: { label: 'Business Insurance', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  bank_charges: { label: 'Bank Charges', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  office_supplies: { label: 'Office Supplies', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  subscriptions_software: { label: 'Subscriptions & Software', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },

  pension_contributions: { label: 'Pension Contributions', isIncome: false, isAllowableDeduction: false, isReliefDeduction: true, note: 'Tax-exempt under PITA s.20' },
  nhis: { label: 'NHIS / Health Insurance', isIncome: false, isAllowableDeduction: false, isReliefDeduction: true, note: 'Tax-exempt under PITA s.20' },
  life_assurance: { label: 'Life Assurance Premiums', isIncome: false, isAllowableDeduction: false, isReliefDeduction: true, note: 'Tax-exempt under PITA s.20, subject to limits' },

  capital_expenditure: { label: 'Capital Expenditure (Asset)', isIncome: false, isAllowableDeduction: false, isReliefDeduction: false, note: 'Excluded from expenses; flows through Capital Allowances schedule' },
  entertainment_disallowed: { label: 'Entertainment (Disallowed)', isIncome: false, isAllowableDeduction: false, isReliefDeduction: false },
  donations_disallowed: { label: 'Donations (Disallowed)', isIncome: false, isAllowableDeduction: false, isReliefDeduction: false, note: 'Donations to specific approved bodies may be deductible — flag for review' },
  fines_penalties: { label: 'Fines & Penalties', isIncome: false, isAllowableDeduction: false, isReliefDeduction: false },
  owner_drawings: { label: 'Owner Drawings', isIncome: false, isAllowableDeduction: false, isReliefDeduction: false },
  private_expense: { label: 'Private/Personal Expense', isIncome: false, isAllowableDeduction: false, isReliefDeduction: false },

  other_allowable: { label: 'Other Allowable Expense', isIncome: false, isAllowableDeduction: true, isReliefDeduction: false },
  other_disallowable: { label: 'Other Disallowable Expense', isIncome: false, isAllowableDeduction: false, isReliefDeduction: false },
};

export const TAX_CATEGORIES = Object.keys(TAX_CATEGORY_META) as NigerianTaxCategory[];

// ─────────────────────────────────────────────────────────────────────────────
// PIT BANDS (Personal Income Tax Act, as amended)
// 2024 Tax Reform Bills proposed restructured bands; verify current state
// before relying on these for filing.
// ─────────────────────────────────────────────────────────────────────────────

export interface PitBand {
  upTo: number; // inclusive upper bound of the band, in NGN
  rate: number;
  label: string;
}

export const PIT_BANDS: PitBand[] = [
  { upTo: 300_000, rate: 0.07, label: 'First ₦300,000' },
  { upTo: 600_000, rate: 0.11, label: 'Next ₦300,000' },
  { upTo: 1_100_000, rate: 0.15, label: 'Next ₦500,000' },
  { upTo: 1_600_000, rate: 0.19, label: 'Next ₦500,000' },
  { upTo: 3_200_000, rate: 0.21, label: 'Next ₦1,600,000' },
  { upTo: Infinity, rate: 0.24, label: 'Above ₦3,200,000' },
];

export interface PitTaxBreakdown {
  band: string;
  amountInBand: number;
  rate: number;
  tax: number;
}

export const computePitTax = (taxableIncome: number): { totalTax: number; breakdown: PitTaxBreakdown[] } => {
  let remaining = Math.max(0, taxableIncome);
  let prevCutoff = 0;
  let totalTax = 0;
  const breakdown: PitTaxBreakdown[] = [];

  for (const band of PIT_BANDS) {
    if (remaining <= 0) break;
    const bandWidth = band.upTo - prevCutoff;
    const amountInBand = Math.min(remaining, bandWidth);
    const tax = amountInBand * band.rate;
    breakdown.push({ band: band.label, amountInBand, rate: band.rate, tax });
    totalTax += tax;
    remaining -= amountInBand;
    prevCutoff = band.upTo;
  }
  return { totalTax, breakdown };
};

/**
 * Consolidated Relief Allowance per PITA s.33:
 *   greater of (₦200,000 or 1% of gross income) + 20% of gross income.
 *
 * The "gross income" here is income after subtracting tax-exempt deductions
 * (pension, NHIS, life assurance) but BEFORE applying CRA itself.
 */
export const computeCRA = (incomeForCra: number): number => {
  if (incomeForCra <= 0) return 0;
  const base = Math.max(200_000, incomeForCra * 0.01);
  return base + incomeForCra * 0.2;
};

// ─────────────────────────────────────────────────────────────────────────────
// CAPITAL ALLOWANCES (CITA Second Schedule, widely-cited rates)
// ─────────────────────────────────────────────────────────────────────────────

export type AssetClass =
  | 'industrial_building'
  | 'non_industrial_building'
  | 'plant_machinery'
  | 'furniture_fittings'
  | 'motor_vehicle'
  | 'office_equipment'
  | 'computer_equipment';

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  industrial_building: 'Industrial Building',
  non_industrial_building: 'Non-Industrial Building',
  plant_machinery: 'Plant & Machinery',
  furniture_fittings: 'Furniture & Fittings',
  motor_vehicle: 'Motor Vehicle',
  office_equipment: 'Office Equipment',
  computer_equipment: 'Computer & IT Equipment',
};

export interface CapitalAllowanceRates {
  initial: number; // claimed once, in year of acquisition
  annual: number;  // claimed each year on remaining tax-written-down value
}

export const CAPITAL_ALLOWANCE_RATES: Record<AssetClass, CapitalAllowanceRates> = {
  industrial_building: { initial: 0.15, annual: 0.10 },
  non_industrial_building: { initial: 0.05, annual: 0.10 },
  plant_machinery: { initial: 0.50, annual: 0.25 },
  furniture_fittings: { initial: 0.25, annual: 0.20 },
  motor_vehicle: { initial: 0.50, annual: 0.25 },
  office_equipment: { initial: 0.50, annual: 0.25 },
  computer_equipment: { initial: 0.50, annual: 0.25 },
};

export interface AssetForAllowance {
  cost: number;
  assetClass: AssetClass;
  acquiredOn: Date | string;
  disposedOn?: Date | string | null;
}

/**
 * Computes the capital allowance an asset can claim for a given tax year.
 * Simplified model: assumes prior years claimed their full annual allowance.
 * Production-grade tracking would store year-by-year claims; this is sufficient
 * for an export users review with their accountant.
 */
export const computeCapitalAllowance = (asset: AssetForAllowance, taxYear: number): number => {
  const rates = CAPITAL_ALLOWANCE_RATES[asset.assetClass];
  if (!rates) return 0;

  const acquired = new Date(asset.acquiredOn);
  const disposed = asset.disposedOn ? new Date(asset.disposedOn) : null;
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEnd = new Date(Date.UTC(taxYear, 11, 31, 23, 59, 59));

  if (acquired > yearEnd) return 0;
  if (disposed && disposed < yearStart) return 0;

  const acquiredYear = acquired.getUTCFullYear();
  const initialAllowance = asset.cost * rates.initial;
  const annualAllowance = asset.cost * rates.annual;

  if (acquiredYear === taxYear) {
    // Year of acquisition: initial + first annual, capped by total cost minus
    // a nominal residual to avoid taking the asset entirely to zero in year 1.
    return Math.min(asset.cost, initialAllowance + annualAllowance);
  }

  // Prior years: assume initial + (n-1) full annual claims taken.
  const yearsClaimed = taxYear - acquiredYear; // number of annual claims already taken
  const cumulativeBefore = initialAllowance + annualAllowance * yearsClaimed;
  let twdv = asset.cost - cumulativeBefore;
  if (twdv <= 0) return 0;
  return Math.min(twdv, annualAllowance);
};

// ─────────────────────────────────────────────────────────────────────────────
// INFERENCE — guess a tax category from the user's free-text "category" or
// "description" field. Used to backfill before the user has classified.
// ─────────────────────────────────────────────────────────────────────────────

export const inferTaxCategory = (
  freeText: string | undefined,
  type: 'income' | 'expense',
): NigerianTaxCategory | null => {
  const s = (freeText || '').toLowerCase();

  if (type === 'income') {
    if (!s) return 'income_business';
    if (/\b(grant|gift|interest|dividend|royalty)\b/.test(s)) return 'income_other';
    return 'income_business';
  }

  if (!s) return null;

  const map: Array<[RegExp, NigerianTaxCategory]> = [
    [/\b(rent|lease)\b/, 'rent'],
    [/\b(salary|salaries|wages|payroll|staff|employee)\b/, 'salaries'],
    [/\b(electric|nepa|phcn|utility|utilities|water|generator|diesel|gas|ikedc|aedc|eko electric)\b/, 'utilities'],
    [/\b(legal|accountant|auditor|consulting|consultant|professional|lawyer)\b/, 'professional_fees'],
    [/\b(repair|maintenance|servicing|fix)\b/, 'repairs_maintenance'],
    [/\b(uber|bolt|taxi|transport|travel|fuel|petrol|flight|airfare|hotel|lodging)\b/, 'transport'],
    [/\b(ad|ads|advertis|marketing|facebook ads|google ads|instagram|promotion|billboard)\b/, 'advertising_marketing'],
    [/\b(insurance)\b/, 'insurance'],
    [/\b(bank charge|sms alert|stamp duty|maintenance fee)\b/, 'bank_charges'],
    [/\b(stationery|paper|office supplies|toner|ink|pen)\b/, 'office_supplies'],
    [/\b(subscription|software|saas|hosting|domain|github|figma|notion|slack|google workspace|microsoft)\b/, 'subscriptions_software'],
    [/\b(pension|pencom|rsa)\b/, 'pension_contributions'],
    [/\b(nhis|hmo|health insurance)\b/, 'nhis'],
    [/\b(life assurance|life insurance)\b/, 'life_assurance'],
    [/\b(asset|equipment|laptop|computer|machinery|furniture|vehicle|property|building)\b/, 'capital_expenditure'],
    [/\b(entertainment|client lunch|client dinner|hospitality)\b/, 'entertainment_disallowed'],
    [/\b(donation|charity|tithe|offering)\b/, 'donations_disallowed'],
    [/\b(fine|penalty|sanction)\b/, 'fines_penalties'],
    [/\b(drawing|owner withdrawal|personal withdrawal)\b/, 'owner_drawings'],
    [/\b(personal|private)\b/, 'private_expense'],
  ];
  for (const [re, cat] of map) {
    if (re.test(s)) return cat;
  }
  return null;
};
