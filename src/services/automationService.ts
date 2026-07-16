import mongoose from 'mongoose';
import AutoCommitRule from '../models/AutoCommitRule.js';
import SmartMapping from '../models/SmartMapping.js';
import { emitToBusiness } from './socketService.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

const sanitizeRulePayload = (body: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  if (typeof body.name === 'string') out.name = body.name.trim();
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (typeof body.vendorPattern === 'string') out.vendorPattern = body.vendorPattern.trim();
  if (Array.isArray(body.categories)) {
    out.categories = body.categories
      .filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c: string) => c.trim());
  }
  if (typeof body.maxAmount === 'number' && body.maxAmount >= 0) out.maxAmount = body.maxAmount;
  if (typeof body.minConfidence === 'number') out.minConfidence = Math.min(1, Math.max(0, body.minConfidence));
  if (body.type === 'income' || body.type === 'expense') out.type = body.type;
  if (typeof body.defaultCategory === 'string') out.defaultCategory = body.defaultCategory.trim();
  return out;
};

export const listRulesForBusiness = (businessId: mongoose.Types.ObjectId) =>
  AutoCommitRule.find({ businessId }).sort({ createdAt: -1 });

export const createRuleForBusiness = async (user: IUser, body: Record<string, unknown>) => {
  const data = sanitizeRulePayload(body);
  if (!data.name) throw new AppError('Rule name is required', 400);

  const rule = await AutoCommitRule.create({ ...data, businessId: user.businessId, createdBy: user._id });
  emitToBusiness(String(user.businessId), 'data_updated', { type: 'autoRule', action: 'created' });
  return rule;
};

export const updateRuleForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  body: Record<string, unknown>,
) => {
  const data = sanitizeRulePayload(body);
  const rule = await AutoCommitRule.findOneAndUpdate({ _id: id, businessId }, { $set: data }, { new: true });
  if (!rule) throw new AppError('Rule not found', 404);

  emitToBusiness(String(businessId), 'data_updated', { type: 'autoRule', action: 'updated' });
  return rule;
};

export const getLearningStatsForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const [patternCount, highConfidenceCount] = await Promise.all([
    SmartMapping.countDocuments({ businessId }),
    SmartMapping.countDocuments({ businessId, confidenceScore: { $gte: 3 } }),
  ]);
  return { patternCount, highConfidenceCount };
};

export const deleteRuleForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const rule = await AutoCommitRule.findOneAndDelete({ _id: id, businessId });
  if (!rule) throw new AppError('Rule not found', 404);

  emitToBusiness(String(businessId), 'data_updated', { type: 'autoRule', action: 'deleted' });
};
