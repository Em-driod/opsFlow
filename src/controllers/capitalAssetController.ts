import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as capitalAssetService from '../services/capitalAssetService.js';

export const listAssets = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const enriched = await capitalAssetService.listAssetsForBusiness(req.user.businessId);
  res.json(enriched);
});

export const createAsset = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const asset = await capitalAssetService.createAssetForBusiness(req.user, req.body);
  res.status(201).json(asset);
});

export const updateAsset = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const asset = await capitalAssetService.updateAssetForBusiness(req.params.id!, req.user.businessId, req.body);
  res.json(asset);
});

export const deleteAsset = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await capitalAssetService.deleteAssetForBusiness(req.params.id!, req.user.businessId);
  res.json({ message: 'Asset deleted' });
});
