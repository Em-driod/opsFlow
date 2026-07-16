import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import ScannedTransaction from '../models/ScannedTransaction.js';
import Proposal from '../models/Proposal.js';

export const getKpisForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const startOfMonth = new Date(currentYear, currentMonth, 1);
  const dayOfMonth = now.getDate();

  const currentPeriodTransactions = await Transaction.aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(businessId), createdAt: { $gte: startOfMonth } } },
    {
      $group: {
        _id: { type: '$type', day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
        total: { $sum: '$amount' },
      },
    },
  ]);

  const incomeTrend: number[] = Array(dayOfMonth).fill(0);
  const expenseTrend: number[] = Array(dayOfMonth).fill(0);
  let totalIncome = 0;
  let totalExpenses = 0;

  currentPeriodTransactions.forEach((t) => {
    const [, , d] = t._id.day.split('-');
    const dayIndex = Number(d) - 1;

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

  const [pendingProposals, overdueInvoices] = await Promise.all([
    Proposal.countDocuments({ businessId, status: 'sent' }),
    Invoice.countDocuments({ businessId, status: 'overdue' }),
  ]);

  const newClientsPerDay = await Client.aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(businessId), createdAt: { $gte: startOfMonth } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
  ]);

  const clientTrend: number[] = Array(dayOfMonth).fill(0);
  newClientsPerDay.forEach((c) => {
    const dayIndex = Number(c._id.split('-')[2]) - 1;
    if (dayIndex >= 0 && dayIndex < dayOfMonth) {
      clientTrend[dayIndex] = c.count;
    }
  });

  return {
    totalIncome: { value: totalIncome, trend: incomeTrend },
    totalExpenses: { value: totalExpenses, trend: expenseTrend },
    netProfit: { value: netProfit, trend: netProfitTrend },
    totalClients: { value: totalClients, trend: clientTrend },
    pendingProposals,
    overdueInvoices,
  };
};

export const getChartDataForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { year?: string; month?: string },
) => {
  const { year, month } = params;
  let startDate: Date, endDate: Date;

  if (year) {
    const y = parseInt(year);
    if (month) {
      const m = parseInt(month);
      startDate = new Date(y, m - 1, 1);
      endDate = new Date(y, m, 0);
    } else {
      startDate = new Date(y, 0, 1);
      endDate = new Date(y, 11, 31);
    }
  } else {
    endDate = new Date();
    startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 6);
  }

  return Transaction.aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(businessId), createdAt: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        totalIncome: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        totalExpenses: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
    {
      $project: {
        _id: 0,
        month: {
          $let: {
            vars: {
              monthsInYear: [null, 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
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
};

export const getOnboardingStatusForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const bizObjectId = new mongoose.Types.ObjectId(businessId);
  const [hasClient, hasTransaction, hasInvoice, hasScannedDoc] = await Promise.all([
    Client.exists({ businessId: bizObjectId }),
    Transaction.exists({ businessId: bizObjectId }),
    Invoice.exists({ businessId: bizObjectId }),
    ScannedTransaction.exists({ businessId: bizObjectId }),
  ]);

  return {
    hasClient: !!hasClient,
    hasTransaction: !!hasTransaction,
    hasInvoice: !!hasInvoice,
    hasScannedDoc: !!hasScannedDoc,
  };
};
