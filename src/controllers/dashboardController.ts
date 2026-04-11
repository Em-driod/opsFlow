import type { Request, Response } from 'express';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import mongoose from 'mongoose';

/**
 * @desc    Get Key Performance Indicators (KPIs) with Sparkline Trends
 * @route   GET /api/dashboard/kpis
 * @access  Private
 */
export const getKpis = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const now = new Date();
    
    // We'll calculate a 7-day trend array for the sparklines
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);
    
    const previousSevenDaysAgo = new Date(now);
    previousSevenDaysAgo.setDate(now.getDate() - 14);

    // Get current 7-day aggregation
    const currentPeriodTransactions = await Transaction.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          createdAt: { $gte: sevenDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            type: '$type',
            day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
          },
          total: { $sum: '$amount' },
        },
      },
    ]);

    // Format into daily buckets for the sparkline [Day1, Day2, ... Day7]
    const incomeTrend: number[] = Array(7).fill(0);
    const expenseTrend: number[] = Array(7).fill(0);
    let totalIncome = 0;
    let totalExpenses = 0;

    currentPeriodTransactions.forEach(t => {
       const [y, m, d] = t._id.day.split('-');
       const dateOfTx = new Date(Number(y), Number(m) - 1, Number(d));
       // Calculate index (0 to 6) based on days ago
       const diffTime = Math.abs(now.getTime() - dateOfTx.getTime());
       const diffDays = 6 - Math.min(6, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
       
       if (t._id.type === 'income') {
         incomeTrend[diffDays] += t.total;
         totalIncome += t.total;
       } else {
         expenseTrend[diffDays] += t.total;
         totalExpenses += t.total;
       }
    });

    const netProfitTrend = incomeTrend.map((inc, i) => inc - expenseTrend[i]);
    const netProfit = totalIncome - totalExpenses;

    const totalClients = await Client.countDocuments({ businessId, status: 'active' });

    res.status(200).json({
      totalIncome: { value: totalIncome, trend: incomeTrend },
      totalExpenses: { value: totalExpenses, trend: expenseTrend },
      netProfit: { value: netProfit, trend: netProfitTrend },
      totalClients: { value: totalClients, trend: [totalClients - 2, totalClients - 1, totalClients, totalClients, totalClients, totalClients, totalClients] } // mock trend
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
