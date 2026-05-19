import type { Request, Response } from 'express';
import CapitalAsset from '../models/CapitalAsset.js';
import { ASSET_CLASS_LABELS, computeCapitalAllowance, type AssetClass } from '../services/nigerianTax.js';
import { emitToBusiness } from '../services/socketService.js';

const VALID_CLASSES = Object.keys(ASSET_CLASS_LABELS) as AssetClass[];

const sanitize = (body: any) => {
  const out: any = {};
  if (typeof body.name === 'string') out.name = body.name.trim();
  if (VALID_CLASSES.includes(body.assetClass)) out.assetClass = body.assetClass;
  if (typeof body.cost === 'number' && body.cost >= 0) out.cost = body.cost;
  if (body.acquiredOn) out.acquiredOn = new Date(body.acquiredOn);
  if (body.disposedOn === null) out.disposedOn = null;
  else if (body.disposedOn) out.disposedOn = new Date(body.disposedOn);
  if (typeof body.notes === 'string') out.notes = body.notes;
  return out;
};

export const listAssets = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const assets = await CapitalAsset.find({ businessId }).sort({ acquiredOn: -1 });
    const enriched = assets.map((a) => {
      const obj = a.toObject() as any;
      const currentYear = new Date().getFullYear();
      obj.currentYearAllowance = computeCapitalAllowance(obj, currentYear);
      obj.assetClassLabel = ASSET_CLASS_LABELS[obj.assetClass as AssetClass];
      return obj;
    });
    res.json(enriched);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const createAsset = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const data = sanitize(req.body);
    if (!data.name || !data.assetClass || typeof data.cost !== 'number' || !data.acquiredOn) {
      return res.status(400).json({ message: 'name, assetClass, cost, and acquiredOn are required' });
    }
    const asset = await CapitalAsset.create({
      ...data,
      businessId: user.businessId,
      createdBy: user._id,
    });
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'capitalAsset', action: 'created' });
    res.status(201).json(asset);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const updateAsset = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const data = sanitize(req.body);
    const asset = await CapitalAsset.findOneAndUpdate(
      { _id: req.params.id, businessId: user.businessId },
      { $set: data },
      { new: true },
    );
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'capitalAsset', action: 'updated' });
    res.json(asset);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const deleteAsset = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const asset = await CapitalAsset.findOneAndDelete({ _id: req.params.id, businessId: user.businessId });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'capitalAsset', action: 'deleted' });
    res.json({ message: 'Asset deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
