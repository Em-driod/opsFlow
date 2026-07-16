import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as reportingService from '../services/reportingService.js';

/**
 * @desc    Generate a financial summary report
 * @route   GET /api/reporting/financial-summary
 * @access  Private
 */
export const getFinancialSummary = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { startDate, endDate, groupBy } = req.query;
  const report = await reportingService.getFinancialSummaryForBusiness(req.user.businessId, {
    startDate: startDate as string,
    endDate: endDate as string,
    groupBy: groupBy as string,
  });
  res.status(200).json(report);
});

/**
 * @desc    Generate a detailed transactions report
 * @route   GET /api/reporting/detailed-transactions
 * @access  Private
 */
export const getDetailedTransactions = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { startDate, endDate, groupBy } = req.query;
  const transactions = await reportingService.getDetailedTransactionsForBusiness(req.user.businessId, {
    startDate: startDate as string,
    endDate: endDate as string,
    groupBy: groupBy as string,
  });
  res.status(200).json(transactions);
});

/**
 * @desc    Monthly income/expense trend for the last N months
 * @route   GET /api/reporting/monthly-trend?months=12
 * @access  Private
 */
export const getMonthlyTrend = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await reportingService.getMonthlyTrendForBusiness(req.user.businessId, req.query.months as string);
  res.json(result);
});
