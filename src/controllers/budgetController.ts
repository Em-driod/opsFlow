import type { Request, Response } from 'express';
import Budget from '../models/Budget.js';
import Transaction from '../models/Transaction.js';
import mongoose from 'mongoose';

const currentPeriod = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const prevPeriod = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y!, m! - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const periodRange = (period: string) => {
  const parts = period.split('-');
  const year = parseInt(parts[0]!, 10);
  const month = parseInt(parts[1]!, 10);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end };
};

export const getBudgets = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const period = (req.query.period as string) || currentPeriod();
    const { start, end } = periodRange(period);

    const [budgets, spendingAgg] = await Promise.all([
      Budget.find({ businessId, period }).sort({ category: 1 }),
      Transaction.aggregate([
        {
          $match: {
            businessId: new mongoose.Types.ObjectId(businessId),
            type: 'expense',
            date: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: '$category', spent: { $sum: '$amount' } } },
      ]),
    ]);

    const spendingMap: Record<string, number> = {};
    for (const row of spendingAgg) {
      spendingMap[row._id || 'Uncategorized'] = row.spent;
    }

    const enriched = budgets.map((b) => ({
      ...b.toObject(),
      spent: spendingMap[b.category] || 0,
    }));

    // Also tell the client whether the previous period has budgets (for copy prompt)
    const prev = prevPeriod(period);
    const prevCount = await Budget.countDocuments({ businessId, period: prev });

    res.json({ budgets: enriched, period, prevPeriod: prev, hasPrev: prevCount > 0 });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const createBudget = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const { category, monthlyLimit, period } = req.body;
    const p = period || currentPeriod();
    if (!category || typeof monthlyLimit !== 'number' || monthlyLimit < 0) {
      return res.status(400).json({ message: 'category and monthlyLimit are required' });
    }
    const budget = await Budget.create({ businessId, category, monthlyLimit, period: p });
    res.status(201).json({ ...budget.toObject(), spent: 0 });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A budget for this category already exists for this month' });
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

export const updateBudget = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const { monthlyLimit, category } = req.body;
    const update: any = {};
    if (typeof monthlyLimit === 'number') update.monthlyLimit = monthlyLimit;
    if (category) update.category = category;

    const budget = await Budget.findOneAndUpdate(
      { _id: req.params.id, businessId },
      { $set: update },
      { new: true },
    );
    if (!budget) return res.status(404).json({ message: 'Budget not found' });
    res.json(budget);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const deleteBudget = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const budget = await Budget.findOneAndDelete({ _id: req.params.id, businessId });
    if (!budget) return res.status(404).json({ message: 'Budget not found' });
    res.json({ message: 'Budget deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

// Copy all budgets from previous period into the target period
export const copyBudgets = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const { fromPeriod, toPeriod } = req.body;
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ message: 'fromPeriod and toPeriod are required' });
    }

    const source = await Budget.find({ businessId, period: fromPeriod });
    if (source.length === 0) {
      return res.status(404).json({ message: 'No budgets found for source period' });
    }

    // Insert only categories that don't already exist in toPeriod
    const existing = await Budget.find({ businessId, period: toPeriod }).select('category');
    const existingCats = new Set(existing.map(b => b.category));

    const toInsert = source
      .filter(b => !existingCats.has(b.category))
      .map(b => ({ businessId, category: b.category, monthlyLimit: b.monthlyLimit, period: toPeriod }));

    if (toInsert.length === 0) {
      return res.status(409).json({ message: 'All categories already exist for this period' });
    }

    const created = await Budget.insertMany(toInsert);
    res.status(201).json({ copied: created.length, budgets: created });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
