import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as searchService from '../services/searchService.js';

export const globalSearch = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await searchService.globalSearchForBusiness(req.user.businessId, (req.query.q as string) || '');
  res.json(result);
});
