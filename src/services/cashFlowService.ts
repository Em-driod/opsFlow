import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';

interface ProjectionPoint {
  month: string;
  totalIncome: number;
  totalExpenses: number;
}

type DataConfidence = 'low' | 'medium' | 'high';

interface CashFlowAnalysis {
  metrics: {
    healthScore: number;
    cashRunwayMonths: number;
    monthlyBurnRate: number;
    netMargin: number;
    overdueDebt: number;
    projectedRevenueNext30d: number;
  };
  dataQuality: {
    confidence: DataConfidence;
    daysOfHistory: number;
    transactionsLast90d: number;
    caveat: string | null;
  };
  projections: ProjectionPoint[];
}

/**
 * Calculates business intelligence metrics and future cash flow projections
 * using MongoDB aggregation pipelines for O(1) database-layer computation.
 * 
 * CRITICAL FIX: The previous implementation used Transaction.find() to pull
 * the ENTIRE transaction history into Node memory, then looped over it with .reduce().
 * This caused guaranteed crashes & OOM errors for businesses with large datasets.
 * 
 * This version delegates ALL arithmetic to MongoDB, which is built for it.
 * It scales to millions of transactions without ever materialising the data in Node.
 */
export const analyzeCashFlow = async (businessId: string): Promise<CashFlowAnalysis> => {
  const businessObjectId = new mongoose.Types.ObjectId(businessId);
  const today = new Date();
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(today.getDate() - 90);

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. BURN RATE — Total expenses in last 90 days, computed entirely in MongoDB
  // ─────────────────────────────────────────────────────────────────────────────
  const [burnResult] = await Transaction.aggregate([
    {
      $match: {
        businessId: businessObjectId,
        type: 'expense',
        createdAt: { $gte: ninetyDaysAgo },
      },
    },
    {
      $group: {
        _id: null,
        totalExpenses90d: { $sum: '$amount' },
        totalIncome90d: { $sum: 0 }, // placeholder shape
      },
    },
  ]);
  const totalExpenses90d: number = burnResult?.totalExpenses90d ?? 0;
  const monthlyBurnRate = totalExpenses90d / 3;

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. INCOME (90d) — For net margin calculation
  // ─────────────────────────────────────────────────────────────────────────────
  const [incomeResult] = await Transaction.aggregate([
    {
      $match: {
        businessId: businessObjectId,
        type: 'income',
        createdAt: { $gte: ninetyDaysAgo },
      },
    },
    {
      $group: {
        _id: null,
        totalIncome90d: { $sum: '$amount' },
      },
    },
  ]);
  const totalIncome90d: number = incomeResult?.totalIncome90d ?? 0;

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. CURRENT CASH POSITION — Income minus Expenses across ALL time, in ONE query
  //    Old code: Transaction.find({ businessId }) then .reduce() over the full array.
  //    New code: MongoDB does the group-by-type and sum in the database layer.
  // ─────────────────────────────────────────────────────────────────────────────
  const cashPositionGroups = await Transaction.aggregate([
    { $match: { businessId: businessObjectId } },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
      },
    },
  ]);

  let allTimeIncome = 0;
  let allTimeExpense = 0;
  for (const group of cashPositionGroups) {
    if (group._id === 'income') allTimeIncome = group.total;
    if (group._id === 'expense') allTimeExpense = group.total;
  }
  const currentCash = allTimeIncome - allTimeExpense;

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. CASH RUNWAY
  // ─────────────────────────────────────────────────────────────────────────────
  const cashRunwayMonths =
    monthlyBurnRate > 0 ? Math.max(0, currentCash) / monthlyBurnRate : 99;

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. REVENUE PROJECTION FROM ACTIVE CLIENTS
  //    Old code: N+1 problem — 1 DB query per active client, inside a Promise.all loop.
  //    New code: One aggregation that filters by client IDs and sums in one pass.
  // ─────────────────────────────────────────────────────────────────────────────
  const activeClients = await Client.find({
    businessId: businessObjectId,
    status: 'active',
  }).select('_id');
  const activeClientIds = activeClients.map((c) => c._id);

  let projectedMonthlyRevenue = 0;
  if (activeClientIds.length > 0) {
    const [projectionResult] = await Transaction.aggregate([
      {
        $match: {
          businessId: businessObjectId,
          type: 'income',
          clientId: { $in: activeClientIds },
          createdAt: { $gte: ninetyDaysAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalClientRevenue90d: { $sum: '$amount' },
        },
      },
    ]);
    const totalClientRevenue90d: number =
      projectionResult?.totalClientRevenue90d ?? 0;
    projectedMonthlyRevenue = totalClientRevenue90d / 3;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. NET MARGIN
  // ─────────────────────────────────────────────────────────────────────────────
  const netMargin =
    totalIncome90d > 0
      ? ((totalIncome90d - totalExpenses90d) / totalIncome90d) * 100
      : 0;

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. DATA QUALITY — projections are useless without enough history.
  //    We surface confidence so the UI can label numbers honestly instead of
  //    showing precise-looking estimates built on sparse data.
  // ─────────────────────────────────────────────────────────────────────────────
  const [oldestTx, txCountResult] = await Promise.all([
    Transaction.findOne({ businessId: businessObjectId }).sort({ createdAt: 1 }).select('createdAt'),
    Transaction.countDocuments({ businessId: businessObjectId, createdAt: { $gte: ninetyDaysAgo } }),
  ]);
  const daysOfHistory = oldestTx
    ? Math.floor((today.getTime() - new Date((oldestTx as any).createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;
  const transactionsLast90d = txCountResult || 0;

  const dataQuality = computeDataQuality(daysOfHistory, transactionsLast90d);

  return {
    metrics: {
      healthScore: calculateHealthScore(netMargin, cashRunwayMonths),
      cashRunwayMonths: Number(cashRunwayMonths.toFixed(1)),
      monthlyBurnRate: Number(monthlyBurnRate.toFixed(2)),
      netMargin: Number(netMargin.toFixed(1)),
      overdueDebt: 0, // Calculated separately in intelligenceController via Invoice model
      projectedRevenueNext30d: Number(projectedMonthlyRevenue.toFixed(2)),
    },
    dataQuality,
    projections: [], // Populated by the dashboard chart endpoint separately
  };
};

const computeDataQuality = (
  daysOfHistory: number,
  transactionsLast90d: number,
): { confidence: DataConfidence; daysOfHistory: number; transactionsLast90d: number; caveat: string | null } => {
  if (daysOfHistory < 30 || transactionsLast90d < 10) {
    return {
      confidence: 'low',
      daysOfHistory,
      transactionsLast90d,
      caveat: `Only ${daysOfHistory} days of data and ${transactionsLast90d} transactions in the last 90 days. Projections are rough estimates.`,
    };
  }
  if (daysOfHistory < 90 || transactionsLast90d < 30) {
    return {
      confidence: 'medium',
      daysOfHistory,
      transactionsLast90d,
      caveat: `${daysOfHistory} days of history. Numbers will tighten as more transactions accumulate.`,
    };
  }
  return {
    confidence: 'high',
    daysOfHistory,
    transactionsLast90d,
    caveat: null,
  };
};

const calculateHealthScore = (margin: number, runway: number): number => {
  let score = 50;
  if (margin > 20) score += 20;
  else if (margin > 0) score += 10;
  else score -= 20;

  if (runway > 6) score += 20;
  else if (runway > 3) score += 10;
  else score -= 20;

  return Math.max(0, Math.min(100, score));
};
