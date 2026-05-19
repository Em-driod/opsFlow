import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import CapitalAsset from '../models/CapitalAsset.js';
import {
  TAX_CATEGORY_META,
  computePitTax,
  computeCRA,
  computeCapitalAllowance,
  inferTaxCategory,
  type NigerianTaxCategory,
  type PitTaxBreakdown,
} from './nigerianTax.js';

export interface CategoryRollup {
  taxCategory: NigerianTaxCategory;
  label: string;
  amount: number;
  count: number;
  isIncome: boolean;
  isAllowable: boolean;
  isRelief: boolean;
}

export interface PitSummary {
  taxYear: number;
  generatedAt: string;

  // Money flow
  grossIncome: number;
  totalAllowableExpenses: number;
  totalDisallowedExpenses: number;
  totalReliefDeductions: number;
  capitalAllowance: number;

  // Sequence per PITA s.33 reading:
  //   gross income
  //     - allowable business expenses
  //     - capital allowance
  //   = total income (also called "earned income")
  //     - tax-exempt reliefs (pension, NHIS, life assurance)
  //   = income before CRA
  //     - CRA
  //   = chargeable / taxable income → bands
  totalIncome: number;
  incomeBeforeCra: number;
  consolidatedRelief: number;
  taxableIncome: number;
  taxComputation: { totalTax: number; breakdown: PitTaxBreakdown[] };

  // Diagnostic info
  byCategory: CategoryRollup[];
  unclassifiedCount: number;
  unclassifiedAmount: number;
  caveats: string[];
}

export const computePitSummary = async (businessId: string, taxYear: number): Promise<PitSummary> => {
  const businessObjectId = new mongoose.Types.ObjectId(businessId);
  const start = new Date(Date.UTC(taxYear, 0, 1));
  const end = new Date(Date.UTC(taxYear, 11, 31, 23, 59, 59));

  const [transactions, capitalAssets] = await Promise.all([
    Transaction.find({
      businessId: businessObjectId,
      createdAt: { $gte: start, $lte: end },
    }).select('amount type category description taxCategory').lean(),
    CapitalAsset.find({ businessId: businessObjectId }).lean(),
  ]);

  const rollups = new Map<NigerianTaxCategory, CategoryRollup>();
  let unclassifiedCount = 0;
  let unclassifiedAmount = 0;

  for (const tx of transactions) {
    const stored = (tx as any).taxCategory as NigerianTaxCategory | undefined;
    const inferred = stored || inferTaxCategory((tx as any).category, tx.type);

    if (!inferred) {
      unclassifiedCount++;
      unclassifiedAmount += tx.amount;
      continue;
    }

    const meta = TAX_CATEGORY_META[inferred];
    if (!meta) {
      unclassifiedCount++;
      unclassifiedAmount += tx.amount;
      continue;
    }

    const existing = rollups.get(inferred) || {
      taxCategory: inferred,
      label: meta.label,
      amount: 0,
      count: 0,
      isIncome: meta.isIncome,
      isAllowable: meta.isAllowableDeduction,
      isRelief: meta.isReliefDeduction,
    };
    existing.amount += tx.amount;
    existing.count += 1;
    rollups.set(inferred, existing);
  }

  let grossIncome = 0;
  let totalAllowableExpenses = 0;
  let totalReliefDeductions = 0;
  let totalDisallowedExpenses = 0;

  for (const r of rollups.values()) {
    if (r.isIncome) grossIncome += r.amount;
    else if (r.isRelief) totalReliefDeductions += r.amount;
    else if (r.isAllowable) totalAllowableExpenses += r.amount;
    else totalDisallowedExpenses += r.amount;
  }

  let capitalAllowance = 0;
  for (const asset of capitalAssets) {
    capitalAllowance += computeCapitalAllowance(asset as any, taxYear);
  }

  const totalIncome = Math.max(0, grossIncome - totalAllowableExpenses - capitalAllowance);
  const incomeBeforeCra = Math.max(0, totalIncome - totalReliefDeductions);
  const consolidatedRelief = computeCRA(incomeBeforeCra);
  const taxableIncome = Math.max(0, incomeBeforeCra - consolidatedRelief);
  const taxComputation = computePitTax(taxableIncome);

  const caveats: string[] = [];
  if (unclassifiedCount > 0) {
    caveats.push(
      `${unclassifiedCount} transaction(s) totalling ₦${Math.round(unclassifiedAmount).toLocaleString()} are unclassified — assign tax categories to include them in the computation.`,
    );
  }
  if (capitalAssets.length === 0 && grossIncome > 0) {
    caveats.push('No capital assets recorded. If you own equipment, vehicles, or property used for business, register them to claim capital allowances.');
  }
  caveats.push('Rates and bands reflect PITA as widely published through early 2025. Validate with a Nigerian Chartered Accountant before filing.');

  // Sort rollup categories: income first, then by amount desc
  const byCategory = Array.from(rollups.values()).sort((a, b) => {
    if (a.isIncome !== b.isIncome) return a.isIncome ? -1 : 1;
    return b.amount - a.amount;
  });

  return {
    taxYear,
    generatedAt: new Date().toISOString(),
    grossIncome,
    totalAllowableExpenses,
    totalDisallowedExpenses,
    totalReliefDeductions,
    capitalAllowance,
    totalIncome,
    incomeBeforeCra,
    consolidatedRelief,
    taxableIncome,
    taxComputation,
    byCategory,
    unclassifiedCount,
    unclassifiedAmount,
    caveats,
  };
};
