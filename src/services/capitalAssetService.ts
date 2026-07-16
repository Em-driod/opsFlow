import mongoose from 'mongoose';
import CapitalAsset, { type ICapitalAsset } from '../models/CapitalAsset.js';
import { ASSET_CLASS_LABELS, computeCapitalAllowance, type AssetClass } from './nigerianTax.js';
import { emitToBusiness } from './socketService.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

type EnrichedAsset = ICapitalAsset & { currentYearAllowance?: number; assetClassLabel?: string };

const VALID_CLASSES = Object.keys(ASSET_CLASS_LABELS) as AssetClass[];

const sanitize = (body: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  if (typeof body.name === 'string') out.name = body.name.trim();
  if (VALID_CLASSES.includes(body.assetClass as AssetClass)) out.assetClass = body.assetClass;
  if (typeof body.cost === 'number' && body.cost >= 0) out.cost = body.cost;
  if (body.acquiredOn) out.acquiredOn = new Date(body.acquiredOn as string);
  if (body.disposedOn === null) out.disposedOn = null;
  else if (body.disposedOn) out.disposedOn = new Date(body.disposedOn as string);
  if (typeof body.notes === 'string') out.notes = body.notes;
  return out;
};

export const listAssetsForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const assets = await CapitalAsset.find({ businessId }).sort({ acquiredOn: -1 });
  const currentYear = new Date().getFullYear();
  return assets.map((a) => {
    const obj = a.toObject() as EnrichedAsset;
    obj.currentYearAllowance = computeCapitalAllowance(obj, currentYear);
    obj.assetClassLabel = ASSET_CLASS_LABELS[obj.assetClass];
    return obj;
  });
};

export const createAssetForBusiness = async (user: IUser, body: Record<string, unknown>) => {
  const data = sanitize(body);
  if (!data.name || !data.assetClass || typeof data.cost !== 'number' || !data.acquiredOn) {
    throw new AppError('name, assetClass, cost, and acquiredOn are required', 400);
  }
  const asset = await CapitalAsset.create({ ...data, businessId: user.businessId, createdBy: user._id });
  emitToBusiness(String(user.businessId), 'data_updated', { type: 'capitalAsset', action: 'created' });
  return asset;
};

export const updateAssetForBusiness = async (id: string, businessId: mongoose.Types.ObjectId, body: Record<string, unknown>) => {
  const data = sanitize(body);
  const asset = await CapitalAsset.findOneAndUpdate({ _id: id, businessId }, { $set: data }, { new: true });
  if (!asset) throw new AppError('Asset not found', 404);
  emitToBusiness(String(businessId), 'data_updated', { type: 'capitalAsset', action: 'updated' });
  return asset;
};

export const deleteAssetForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const asset = await CapitalAsset.findOneAndDelete({ _id: id, businessId });
  if (!asset) throw new AppError('Asset not found', 404);
  emitToBusiness(String(businessId), 'data_updated', { type: 'capitalAsset', action: 'deleted' });
};
