import type { Request, Response } from 'express';
import AutoCommitRule from '../models/AutoCommitRule.js';
import SmartMapping from '../models/SmartMapping.js';
import { emitToBusiness } from '../services/socketService.js';

const sanitizeRulePayload = (body: any) => {
  const out: any = {};
  if (typeof body.name === 'string') out.name = body.name.trim();
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (typeof body.vendorPattern === 'string') out.vendorPattern = body.vendorPattern.trim();
  if (Array.isArray(body.categories)) {
    out.categories = body.categories.filter((c: any) => typeof c === 'string' && c.trim()).map((c: string) => c.trim());
  }
  if (typeof body.maxAmount === 'number' && body.maxAmount >= 0) out.maxAmount = body.maxAmount;
  if (typeof body.minConfidence === 'number') {
    out.minConfidence = Math.min(1, Math.max(0, body.minConfidence));
  }
  if (body.type === 'income' || body.type === 'expense') out.type = body.type;
  if (typeof body.defaultCategory === 'string') out.defaultCategory = body.defaultCategory.trim();
  return out;
};

export const listRules = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const rules = await AutoCommitRule.find({ businessId }).sort({ createdAt: -1 });
    res.json(rules);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const createRule = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const data = sanitizeRulePayload(req.body);
    if (!data.name) {
      return res.status(400).json({ message: 'Rule name is required' });
    }

    const rule = await AutoCommitRule.create({
      ...data,
      businessId: user.businessId,
      createdBy: user._id,
    });

    emitToBusiness(String(user.businessId), 'data_updated', { type: 'autoRule', action: 'created' });

    res.status(201).json(rule);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const updateRule = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const data = sanitizeRulePayload(req.body);

    const rule = await AutoCommitRule.findOneAndUpdate(
      { _id: req.params.id, businessId: user.businessId },
      { $set: data },
      { new: true },
    );

    if (!rule) {
      return res.status(404).json({ message: 'Rule not found' });
    }

    emitToBusiness(String(user.businessId), 'data_updated', { type: 'autoRule', action: 'updated' });

    res.json(rule);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const getLearningStats = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const [patternCount, highConfidenceCount] = await Promise.all([
      SmartMapping.countDocuments({ businessId }),
      SmartMapping.countDocuments({ businessId, confidenceScore: { $gte: 3 } }),
    ]);
    res.json({ patternCount, highConfidenceCount });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

export const deleteRule = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const rule = await AutoCommitRule.findOneAndDelete({
      _id: req.params.id,
      businessId: user.businessId,
    });

    if (!rule) {
      return res.status(404).json({ message: 'Rule not found' });
    }

    emitToBusiness(String(user.businessId), 'data_updated', { type: 'autoRule', action: 'deleted' });

    res.json({ message: 'Rule deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
