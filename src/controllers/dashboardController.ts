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
    
    // Monthly Calculation (Start of current month to now)
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const startOfMonth = new Date(currentYear, currentMonth, 1);
    const dayOfMonth = now.getDate(); // e.g. 1 to 31

    // Get current month aggregation
    const currentPeriodTransactions = await Transaction.aggregate([
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          createdAt: { $gte: startOfMonth },
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

    // Format into daily buckets for the sparkline: [Day1, Day2, ... Day(Today)]
    const incomeTrend: number[] = Array(dayOfMonth).fill(0);
    const expenseTrend: number[] = Array(dayOfMonth).fill(0);
    let totalIncome = 0;
    let totalExpenses = 0;

    currentPeriodTransactions.forEach(t => {
       const [y, m, d] = t._id.day.split('-');
       const dayIndex = Number(d) - 1; // 1st day = index 0

       // Safety check in case of time zone quirks
       if (dayIndex >= 0 && dayIndex < dayOfMonth) {
         if (t._id.type === 'income') {
           incomeTrend[dayIndex] += t.total;
           totalIncome += t.total;
         } else {
           expenseTrend[dayIndex] += t.total;
           totalExpenses += t.total;
         }
       }
    });

    const netProfitTrend = incomeTrend.map((inc, i) => inc - (expenseTrend[i] || 0));
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
