import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as dashboardService from '../services/dashboardService.js';

/**
 * @desc    Get Key Performance Indicators (KPIs) with Sparkline Trends
 * @route   GET /api/dashboard/kpis
 * @access  Private
 */
export const getKpis = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await dashboardService.getKpisForBusiness(req.user.businessId);
  res.status(200).json(result);
});

/**
 * @desc    Get data for the income vs. expense chart
 * @route   GET /api/dashboard/chart-data
 * @access  Private
 */
export const getChartData = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { year, month } = req.query;
  const chartData = await dashboardService.getChartDataForBusiness(req.user.businessId, {
    year: year as string,
    month: month as string,
  });
  res.status(200).json(chartData);
});

/**
 * @desc    Returns which onboarding steps the business has completed
 * @route   GET /api/dashboard/onboarding-status
 * @access  Private
 */
export const getOnboardingStatus = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await dashboardService.getOnboardingStatusForBusiness(req.user.businessId);
  res.status(200).json(result);
});
