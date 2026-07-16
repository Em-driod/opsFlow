import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as budgetService from '../services/budgetService.js';

export const getBudgets = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await budgetService.getBudgetsForBusiness(req.user.businessId, req.query.period as string);
  res.json(result);
});

export const createBudget = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await budgetService.createBudgetForBusiness(req.user.businessId, req.body);
  res.status(201).json(result);
});

export const updateBudget = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const budget = await budgetService.updateBudgetForBusiness(req.params.id!, req.user.businessId, req.body);
  res.json(budget);
});

export const deleteBudget = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await budgetService.deleteBudgetForBusiness(req.params.id!, req.user.businessId);
  res.json({ message: 'Budget deleted' });
});

// Copy all budgets from previous period into the target period
export const copyBudgets = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { fromPeriod, toPeriod } = req.body;
  const result = await budgetService.copyBudgetsForBusiness(req.user.businessId, fromPeriod, toPeriod);
  res.status(201).json(result);
});
