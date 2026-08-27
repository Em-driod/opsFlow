import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as activityService from '../services/activityService.js';

// @desc    Get activity logs for a business
// @route   GET /api/activity
// @access  Private/Admin
export const getActivityLogs = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { page, limit, action, resource, userId, resourceId, severity, q, from, to } = req.query;
  const result = await activityService.getActivityLogsForBusiness(req.user.businessId, {
    page: page as string,
    limit: limit as string,
    action: action as string,
    resource: resource as string,
    userId: userId as string,
    resourceId: resourceId as string,
    severity: severity as string,
    q: q as string,
    from: from as string,
    to: to as string,
  });
  res.json(result);
});

// @desc    Get activity statistics
// @route   GET /api/activity/stats
// @access  Private/Admin
export const getActivityStats = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await activityService.getActivityStatsForBusiness(req.user.businessId, req.query.days as string);
  res.json(result);
});
