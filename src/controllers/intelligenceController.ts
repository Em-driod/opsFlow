import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as intelligenceService from '../services/intelligenceService.js';

// @desc    Get complete Intelligence payload (Metrics + Gemini Advice)
// @route   GET /api/intelligence/advisor
// @access  Private
export const getBusinessAdvisorState = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await intelligenceService.getBusinessAdvisorStateForBusiness(req.user.businessId);
  res.status(200).json(result);
});
