import type { Request, Response } from 'express';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import mongoose from 'mongoose';

/**
 * @desc    Get Key Performance Indicators (KPIs)
 * @route   GET /api/dashboard/kpis
 * @access  Private
 */
export const getKpis = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Calculate total income and expenses in the last 30 days
    const recentTransactions = await Transaction.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' },
        },
      },
    ]);

    const income = recentTransactions.find((t) => t._id === 'income')?.total || 0;
    const expenses = recentTransactions.find((t) => t._id === 'expense')?.total || 0;

    // Get total number of active clients
    const totalClients = await Client.countDocuments({
      businessId,
      status: 'active',
    });

    res.status(200).json({
      totalIncome: income,
      totalExpenses: expenses,
      netProfit: income - expenses,
      totalClients,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Get data for the income vs. expense chart
 * @route   GET /api/dashboard/chart-data
 * @access  Private
 */
export const getChartData = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const { year, month, interval } = req.query;

    let startDate, endDate;

    if (year) {
      const y = parseInt(year as string);
      if (month) {
        // Data for a specific month of a year
        const m = parseInt(month as string);
        startDate = new Date(y, m - 1, 1);
        endDate = new Date(y, m, 0);
      } else {
        // Data for the entire year
        startDate = new Date(y, 0, 1);
        endDate = new Date(y, 11, 31);
      }
    } else {
      // Default: last 6 months
      endDate = new Date();
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 6);
    }

    // Aggregate transactions by month
    const chartData = await Transaction.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          totalIncome: {
            $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
          },
          totalExpenses: {
            $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
          },
        },
      },
      {
        $sort: { '_id.year': 1, '_id.month': 1 },
      },
      {
        $project: {
          _id: 0,
          month: {
            $let: {
              vars: {
                monthsInYear: [
                  null,
                  'Jan',
                  'Feb',
                  'Mar',
                  'Apr',
                  'May',
                  'Jun',
                  'Jul',
                  'Aug',
                  'Sep',
                  'Oct',
                  'Nov',
                  'Dec',
                ],
              },
              in: { $arrayElemAt: ['$$monthsInYear', '$_id.month'] },
            },
          },
          year: '$_id.year',
          totalIncome: 1,
          totalExpenses: 1,
        },
      },
    ]);

    res.status(200).json(chartData);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};
