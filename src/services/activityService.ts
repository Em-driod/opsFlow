import mongoose from 'mongoose';
import ActivityLog from '../models/ActivityLog.js';

interface ListParams {
  page?: string;
  limit?: string;
  action?: string;
  resource?: string;
  userId?: string;
  resourceId?: string;
  severity?: string;
  q?: string;
  from?: string;
  to?: string;
}

const buildQuery = (businessId: mongoose.Types.ObjectId, params: ListParams) => {
  const query: Record<string, unknown> = { businessId };
  if (params.action) query.action = params.action;
  if (params.resource) query.resource = params.resource;
  if (params.userId) query.user = params.userId;
  if (params.resourceId) query.resourceId = params.resourceId;
  if (params.severity) query.severity = params.severity;

  if (params.from || params.to) {
    const range: Record<string, Date> = {};
    if (params.from) range.$gte = new Date(params.from);
    if (params.to) {
      // `to` is an inclusive day — push to end of that day.
      const end = new Date(params.to);
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
    query.createdAt = range;
  }

  if (params.q) {
    const rx = new RegExp(params.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ userName: rx }, { userEmail: rx }, { summary: rx }, { resourceId: params.q }];
  }

  return query;
};

export const getActivityLogsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: ListParams,
) => {
  const query = buildQuery(businessId, params);

  const pageNum = Math.max(1, parseInt(params.page || '1'));
  const limitNum = Math.min(200, Math.max(1, parseInt(params.limit || '50')));
  const skip = (pageNum - 1) * limitNum;

  const [logs, total] = await Promise.all([
    ActivityLog.find(query)
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    ActivityLog.countDocuments(query),
  ]);

  return {
    logs,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
  };
};

export const getActivityStatsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  daysParam?: string,
) => {
  const daysNum = Math.min(365, Math.max(1, parseInt(daysParam || '7')));
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysNum);
  const match = { businessId, createdAt: { $gte: startDate } };

  const [resourceStats, actionStats, userActivity, daily, sensitiveCount, totalCount] = await Promise.all([
    ActivityLog.aggregate([
      { $match: match },
      { $group: { _id: { action: '$action', resource: '$resource' }, count: { $sum: 1 } } },
      {
        $group: {
          _id: '$_id.resource',
          actions: { $push: { action: '$_id.action', count: '$count' } },
          total: { $sum: '$count' },
        },
      },
      { $sort: { total: -1 } },
    ]),
    ActivityLog.aggregate([
      { $match: match },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    ActivityLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$user',
          userName: { $first: '$userName' },
          userEmail: { $first: '$userEmail' },
          count: { $sum: 1 },
          lastActive: { $max: '$createdAt' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    ActivityLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    ActivityLog.countDocuments({ ...match, severity: 'sensitive' }),
    ActivityLog.countDocuments(match),
  ]);

  return {
    resourceStats,
    actionStats,
    userActivity,
    daily,
    sensitiveCount,
    totalCount,
    period: `${daysNum} days`,
    days: daysNum,
  };
};
