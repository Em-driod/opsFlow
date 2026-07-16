import mongoose from 'mongoose';
import Budget from '../models/Budget.js';
import Transaction from '../models/Transaction.js';
import { AppError } from '../utils/AppError.js';

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

export const getBudgetsForBusiness = async (businessId: mongoose.Types.ObjectId, periodParam?: string) => {
  const period = periodParam || currentPeriod();
  const { start, end } = periodRange(period);

  const [budgets, spendingAgg] = await Promise.all([
    Budget.find({ businessId, period }).sort({ category: 1 }),
    Transaction.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId), type: 'expense', date: { $gte: start, $lte: end } } },
      { $group: { _id: '$category', spent: { $sum: '$amount' } } },
    ]),
  ]);

  const spendingMap: Record<string, number> = {};
  for (const row of spendingAgg) {
    spendingMap[row._id || 'Uncategorized'] = row.spent;
  }

  const enriched = budgets.map((b) => ({ ...b.toObject(), spent: spendingMap[b.category] || 0 }));

  const prev = prevPeriod(period);
  const prevCount = await Budget.countDocuments({ businessId, period: prev });

  return { budgets: enriched, period, prevPeriod: prev, hasPrev: prevCount > 0 };
};

export const createBudgetForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { category: string; monthlyLimit: number; period?: string },
) => {
  const { category, monthlyLimit, period } = params;
  const p = period || currentPeriod();
  if (!category || typeof monthlyLimit !== 'number' || monthlyLimit < 0) {
    throw new AppError('category and monthlyLimit are required', 400);
  }

  try {
    const budget = await Budget.create({ businessId, category, monthlyLimit, period: p });
    return { ...budget.toObject(), spent: 0 };
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new AppError('A budget for this category already exists for this month', 400);
    }
    throw error;
  }
};

export const updateBudgetForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  updates: { monthlyLimit?: number; category?: string },
) => {
  const update: Record<string, unknown> = {};
  if (typeof updates.monthlyLimit === 'number') update.monthlyLimit = updates.monthlyLimit;
  if (updates.category) update.category = updates.category;

  const budget = await Budget.findOneAndUpdate({ _id: id, businessId }, { $set: update }, { new: true });
  if (!budget) throw new AppError('Budget not found', 404);
  return budget;
};

export const deleteBudgetForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const budget = await Budget.findOneAndDelete({ _id: id, businessId });
  if (!budget) throw new AppError('Budget not found', 404);
};

export const copyBudgetsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  fromPeriod: string,
  toPeriod: string,
) => {
  if (!fromPeriod || !toPeriod) throw new AppError('fromPeriod and toPeriod are required', 400);

  const source = await Budget.find({ businessId, period: fromPeriod });
  if (source.length === 0) throw new AppError('No budgets found for source period', 404);

  const existing = await Budget.find({ businessId, period: toPeriod }).select('category');
  const existingCats = new Set(existing.map((b) => b.category));

  const toInsert = source
    .filter((b) => !existingCats.has(b.category))
    .map((b) => ({ businessId, category: b.category, monthlyLimit: b.monthlyLimit, period: toPeriod }));

  if (toInsert.length === 0) throw new AppError('All categories already exist for this period', 409);

  const created = await Budget.insertMany(toInsert);
  return { copied: created.length, budgets: created };
};
