import type { Request, Response } from 'express';
import { computePitSummary } from '../services/pitSummary.js';
import { TAX_CATEGORY_META, ASSET_CLASS_LABELS, type NigerianTaxCategory } from '../services/nigerianTax.js';

const csvEscape = (value: any): string => {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

export const getMetadata = async (_req: Request, res: Response) => {
  res.json({
    taxCategories: Object.entries(TAX_CATEGORY_META).map(([id, meta]) => ({
      id: id as NigerianTaxCategory,
      ...meta,
    })),
    assetClasses: Object.entries(ASSET_CLASS_LABELS).map(([id, label]) => ({ id, label })),
  });
};

export const getPitSummary = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const yearRaw = req.query.year;
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear();
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: 'Invalid year' });
    }
    const summary = await computePitSummary(String(businessId), year);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

/**
 * Returns a Form-A-style CSV the user (or their accountant) can paste into the
 * State IRS portal. We are *not* claiming this is a sealed digital filing —
 * it's a structured worksheet the accountant signs off on.
 */
export const exportPitCsv = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const yearRaw = req.query.year;
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear();
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: 'Invalid year' });
    }
    const summary = await computePitSummary(String(businessId), year);

    const lines: string[] = [];
    lines.push(`OpsFlow PIT Worksheet,Tax Year ${summary.taxYear}`);
    lines.push(`Generated,${summary.generatedAt}`);
    lines.push('');
    lines.push('SECTION,LINE,AMOUNT (NGN)');
    lines.push(`Income,Gross Income,${summary.grossIncome.toFixed(2)}`);
    lines.push(`Income,Less: Allowable Business Expenses,${summary.totalAllowableExpenses.toFixed(2)}`);
    lines.push(`Income,Less: Capital Allowance,${summary.capitalAllowance.toFixed(2)}`);
    lines.push(`Income,Total Income,${summary.totalIncome.toFixed(2)}`);
    lines.push(`Reliefs,Less: Pension/NHIS/Life Assurance,${summary.totalReliefDeductions.toFixed(2)}`);
    lines.push(`Reliefs,Income before CRA,${summary.incomeBeforeCra.toFixed(2)}`);
    lines.push(`Reliefs,Less: Consolidated Relief Allowance,${summary.consolidatedRelief.toFixed(2)}`);
    lines.push(`Reliefs,Taxable (Chargeable) Income,${summary.taxableIncome.toFixed(2)}`);
    lines.push('');
    lines.push('TAX COMPUTATION,BAND,AMOUNT IN BAND,RATE,TAX (NGN)');
    for (const b of summary.taxComputation.breakdown) {
      lines.push(`Tax,${csvEscape(b.band)},${b.amountInBand.toFixed(2)},${(b.rate * 100).toFixed(0)}%,${b.tax.toFixed(2)}`);
    }
    lines.push(`Tax,Total Tax Due,,,${summary.taxComputation.totalTax.toFixed(2)}`);
    lines.push('');
    lines.push('CATEGORY BREAKDOWN,CATEGORY,TREATMENT,COUNT,AMOUNT (NGN)');
    for (const c of summary.byCategory) {
      const treatment = c.isIncome ? 'Income' : c.isRelief ? 'Tax Relief' : c.isAllowable ? 'Allowable Expense' : 'Disallowed';
      lines.push(`Breakdown,${csvEscape(c.label)},${treatment},${c.count},${c.amount.toFixed(2)}`);
    }
    if (summary.unclassifiedCount > 0) {
      lines.push(`Breakdown,Unclassified,Pending Review,${summary.unclassifiedCount},${summary.unclassifiedAmount.toFixed(2)}`);
    }
    lines.push('');
    lines.push('NOTES');
    for (const c of summary.caveats) {
      lines.push(`Note,${csvEscape(c)}`);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="opsflow-pit-${summary.taxYear}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
