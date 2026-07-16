import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as taxService from '../services/taxService.js';

export const getMetadata = asyncHandler(async (_req: Request, res: Response) => {
  res.json(taxService.getTaxMetadata());
});

export const getPitSummary = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const summary = await taxService.getPitSummaryForBusiness(String(req.user.businessId), req.query.year);
  res.json(summary);
});

export const exportPitCsv = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { csv, taxYear } = await taxService.exportPitCsvForBusiness(String(req.user.businessId), req.query.year);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="opsflow-pit-${taxYear}.csv"`);
  res.send(csv);
});
