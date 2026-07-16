import mongoose from 'mongoose';
import ActivityLog from '../models/ActivityLog.js';

export const getActivityLogsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { page?: string; limit?: string; action?: string; resource?: string; userId?: string },
) => {
  const query: Record<string, unknown> = { businessId };
  if (params.action) query.action = params.action;
  if (params.resource) query.resource = params.resource;
  if (params.userId) query.user = params.userId;

  const pageNum = parseInt(params.page || '1');
  const limitNum = parseInt(params.limit || '50');
  const skip = (pageNum - 1) * limitNum;

  const [logs, total] = await Promise.all([
    ActivityLog.find(query).populate('user', 'name email').sort({ timestamp: -1 }).skip(skip).limit(limitNum),
    ActivityLog.countDocuments(query),
  ]);

  return {
    logs,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  };
};

export const getActivityStatsForBusiness = async (businessId: mongoose.Types.ObjectId, daysParam?: string) => {
  const daysNum = parseInt(daysParam || '7');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysNum);

  const stats = await ActivityLog.aggregate([
    { $match: { businessId, timestamp: { $gte: startDate } } },
    { $group: { _id: { action: '$action', resource: '$resource' }, count: { $sum: 1 } } },
    {
      $group: {
        _id: '$_id.resource',
        actions: { $push: { action: '$_id.action', count: '$count' } },
        total: { $sum: '$count' },
      },
    },
  ]);

  const userActivity = await ActivityLog.aggregate([
    { $match: { businessId, timestamp: { $gte: startDate } } },
    {
      $group: {
        _id: '$user',
        userName: { $first: '$userName' },
        userEmail: { $first: '$userEmail' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);

  return { resourceStats: stats, userActivity, period: `${daysNum} days` };
};
