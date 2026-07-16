import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as csvImportService from '../services/csvImportService.js';

// @desc    Parse a CSV and return a preview with predicted categories
// @route   POST /api/transactions/csv/preview
// @access  Private
export const previewCsv = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await csvImportService.previewCsvForBusiness(req.user, req.body || {});
  res.json(result);
});

// @desc    Commit selected rows from a CSV import as Transactions
// @route   POST /api/transactions/csv/commit
// @access  Private
export const commitCsv = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await csvImportService.commitCsvForBusiness(req.user, req.body || {});
  res.status(201).json(result);
});
