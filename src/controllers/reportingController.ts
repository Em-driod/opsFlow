import type { Request, Response } from 'express';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import mongoose from 'mongoose';

/**
 * @desc    Generate a financial summary report
 * @route   GET /api/reporting/financial-summary
 * @access  Private
 */
export const getFinancialSummary = async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, groupBy } = req.query;
    const businessId = (req.user as any).businessId;

    console.log('getFinancialSummary: Received params -', {
      startDate,
      endDate,
      groupBy,
      businessId,
    });

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start date and end date are required.' });
    }

    const start = new Date(startDate as string);
    const end = new Date(endDate as string);
    end.setHours(23, 59, 59, 999); // Ensure end date includes the whole day

    console.log('getFinancialSummary: Constructed dates -', { start, end });

    let pipeline: any[] = [
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          createdAt: { $gte: start, $lte: end },
        },
      },
    ];

    // Conditional grouping based on groupBy parameter
    if (groupBy === 'category') {
      pipeline.push({
        $group: {
          _id: '$category',
          totalIncome: {
            $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
          },
          totalExpenses: {
            $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
          },
          netProfit: {
            $sum: {
              $cond: [{ $eq: ['$type', 'income'] }, '$amount', { $multiply: ['$amount', -1] }],
            },
          },
          totalTransactions: { $sum: 1 },
        },
      });
    } else if (groupBy === 'client') {
      pipeline.push({
        $group: {
          _id: '$clientId', // Group by clientId
          totalIncome: {
            $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
          },
          totalExpenses: {
            $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
          },
          netProfit: {
            $sum: {
              $cond: [{ $eq: ['$type', 'income'] }, '$amount', { $multiply: ['$amount', -1] }],
            },
          },
          totalTransactions: { $sum: 1 },
        },
      });
      // If grouping by client, we'll need to populate client names later
    } else {
      // Default: overall summary
      pipeline.push({
        $group: {
          _id: null,
          totalIncome: {
            $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
          },
          totalExpenses: {
            $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
          },
          totalTransactions: { $sum: 1 },
        },
      });
      pipeline.push({
        $project: {
          _id: 0,
          totalIncome: 1,
          totalExpenses: 1,
          netProfit: { $subtract: ['$totalIncome', '$totalExpenses'] },
          totalTransactions: 1,
        },
      });
    }

    const summary = await Transaction.aggregate(pipeline);
    console.log('getFinancialSummary: Aggregation summary result -', summary);

    // If grouping by client, populate client names
    if (groupBy === 'client' && summary.length > 0) {
      await Client.populate(summary, { path: '_id', select: 'name' });
      summary.forEach((item) => {
        item.clientName = item._id ? item._id.name : 'Unknown Client';
        item._id = item._id ? item._id._id : null; // Keep original ID if needed, or set null
      });
    }

    const report =
      summary.length > 0
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

    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Generate a detailed transactions report
 * @route   GET /api/reporting/detailed-transactions
 * @access  Private
 */
export const getDetailedTransactions = async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, groupBy } = req.query;
    const businessId = (req.user as any).businessId;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start date and end date are required.' });
    }

    const start = new Date(startDate as string);
    const end = new Date(endDate as string);
    end.setHours(23, 59, 59, 999); // Ensure end date includes the whole day

    let transactionsQuery = Transaction.find({
      businessId: new mongoose.Types.ObjectId(businessId),
      createdAt: { $gte: start, $lte: end },
    });

    if (groupBy === 'client') {
      transactionsQuery = (transactionsQuery as any).populate('clientId', 'name');
    }

    const transactions = await transactionsQuery.sort({ date: 1 });

    res.status(200).json(transactions);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Monthly income/expense trend for the last N months
 * @route   GET /api/reporting/monthly-trend?months=12
 * @access  Private
 */
export const getMonthlyTrend = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const months = Math.min(Math.max(parseInt(req.query.months as string) || 12, 1), 24);

    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date();
    start.setMonth(start.getMonth() - months + 1);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const rows = await Transaction.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          date: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' },
          },
          income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
          expenses: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const result = rows.map((r) => ({
      month: `${r._id.year}-${String(r._id.month).padStart(2, '0')}`,
      income: r.income,
      expenses: r.expenses,
      net: r.income - r.expenses,
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};
