import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as automationService from '../services/automationService.js';

export const listRules = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const rules = await automationService.listRulesForBusiness(req.user.businessId);
  res.json(rules);
});

export const createRule = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const rule = await automationService.createRuleForBusiness(req.user, req.body);
  res.status(201).json(rule);
});

export const updateRule = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const rule = await automationService.updateRuleForBusiness(req.params.id!, req.user.businessId, req.body);
  res.json(rule);
});

export const getLearningStats = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const stats = await automationService.getLearningStatsForBusiness(req.user.businessId);
  res.json(stats);
});

export const deleteRule = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await automationService.deleteRuleForBusiness(req.params.id!, req.user.businessId);
  res.json({ message: 'Rule deleted' });
});
