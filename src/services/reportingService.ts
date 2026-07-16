import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import { AppError } from '../utils/AppError.js';

export const getFinancialSummaryForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { startDate?: string; endDate?: string; groupBy?: string },
) => {
  const { startDate, endDate, groupBy } = params;
  if (!startDate || !endDate) throw new AppError('Start date and end date are required.', 400);

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const pipeline: mongoose.PipelineStage[] = [
    { $match: { businessId: new mongoose.Types.ObjectId(businessId), createdAt: { $gte: start, $lte: end } } },
  ];

  if (groupBy === 'category') {
    pipeline.push({
      $group: {
        _id: '$category',
        totalIncome: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        totalExpenses: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
        netProfit: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', { $multiply: ['$amount', -1] }] } },
        totalTransactions: { $sum: 1 },
      },
    });
  } else if (groupBy === 'client') {
    pipeline.push({
      $group: {
        _id: '$clientId',
        totalIncome: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        totalExpenses: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
        netProfit: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', { $multiply: ['$amount', -1] }] } },
        totalTransactions: { $sum: 1 },
      },
    });
  } else {
    pipeline.push(
      {
        $group: {
          _id: null,
          totalIncome: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
          totalExpenses: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
          totalTransactions: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          totalIncome: 1,
          totalExpenses: 1,
          netProfit: { $subtract: ['$totalIncome', '$totalExpenses'] },
          totalTransactions: 1,
        },
      },
    );
  }

  const summary: Array<Record<string, unknown>> = await Transaction.aggregate(pipeline);

  if (groupBy === 'client' && summary.length > 0) {
    await Client.populate(summary, { path: '_id', select: 'name' });
    summary.forEach((item) => {
      const populated = item._id as { name?: string; _id?: unknown } | null;
      item.clientName = populated ? populated.name : 'Unknown Client';
      item._id = populated ? populated._id : null;
    });
  }

  return summary.length > 0
    ? summary
    : [
        {
          _id: groupBy === 'category' ? 'Overall' : null,
          totalIncome: 0,
          totalExpenses: 0,
          netProfit: 0,
          totalTransactions: 0,
        },
      ];
};

export const getDetailedTransactionsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { startDate?: string; endDate?: string; groupBy?: string },
) => {
  const { startDate, endDate, groupBy } = params;
  if (!startDate || !endDate) throw new AppError('Start date and end date are required.', 400);

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const transactionsQuery = Transaction.find({
    businessId: new mongoose.Types.ObjectId(businessId),
    createdAt: { $gte: start, $lte: end },
  }).sort({ date: 1 });

  if (groupBy === 'client') {
    transactionsQuery.populate('clientId', 'name');
  }

  return transactionsQuery;
};

export const getMonthlyTrendForBusiness = async (businessId: mongoose.Types.ObjectId, monthsParam?: string) => {
  const months = Math.min(Math.max(parseInt(monthsParam || '12') || 12, 1), 24);

  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setMonth(start.getMonth() - months + 1);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const rows = await Transaction.aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(businessId), date: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: { year: { $year: '$date' }, month: { $month: '$date' } },
        income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        expenses: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  return rows.map((r) => ({
    month: `${r._id.year}-${String(r._id.month).padStart(2, '0')}`,
    income: r.income,
    expenses: r.expenses,
    net: r.income - r.expenses,
  }));
};
