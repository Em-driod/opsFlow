import mongoose from 'mongoose';
import ActivityLog from '../models/ActivityLog.js';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sensitive = destructive or privilege-affecting events.
const SENSITIVE_MATCH = { $or: [{ action: 'DELETE' }, { resource: 'USER', action: 'UPDATE' }] };
const NOTICE_MATCH = { action: { $in: ['UPDATE', 'LOGIN', 'LOGOUT'] }, resource: { $ne: 'USER' } };

export const getActivityLogsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: {
    page?: string;
    limit?: string;
    action?: string;
    resource?: string;
    userId?: string;
    q?: string;
    severity?: string;
    from?: string;
    to?: string;
  },
) => {
  const query: Record<string, unknown> = { businessId };
  const and: Record<string, unknown>[] = [];
  if (params.action) query.action = params.action;
  if (params.resource) query.resource = params.resource;
  if (params.userId && mongoose.Types.ObjectId.isValid(params.userId)) query.user = params.userId;

  if (params.from || params.to) {
    const range: Record<string, Date> = {};
    if (params.from) range.$gte = new Date(`${params.from}T00:00:00.000Z`);
    if (params.to) range.$lte = new Date(`${params.to}T23:59:59.999Z`);
    query.createdAt = range;
  }

  if (params.q) {
    const rx = new RegExp(escapeRegex(params.q), 'i');
    const or: Record<string, unknown>[] = [{ userName: rx }, { userEmail: rx }, { action: rx }, { resource: rx }];
    if (mongoose.Types.ObjectId.isValid(params.q)) or.push({ resourceId: params.q });
    and.push({ $or: or });
  }

  if (params.severity === 'sensitive') and.push(SENSITIVE_MATCH);
  else if (params.severity === 'notice') and.push(NOTICE_MATCH);
  else if (params.severity === 'info') and.push({ $nor: [SENSITIVE_MATCH, NOTICE_MATCH] });

  if (and.length) query.$and = and;

  const pageNum = Math.max(1, parseInt(params.page || '1') || 1);
  const limitNum = Math.min(1000, Math.max(1, parseInt(params.limit || '50') || 50));
  const skip = (pageNum - 1) * limitNum;

  const [docs, total] = await Promise.all([
    ActivityLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
    ActivityLog.countDocuments(query),
  ]);

  const logs = docs.map((d) => {
    const doc = d as unknown as Record<string, unknown> & { action: string; resource: string };
    const sensitive = doc.action === 'DELETE' || (doc.resource === 'USER' && doc.action === 'UPDATE');
    const notice = !sensitive && ['UPDATE', 'LOGIN', 'LOGOUT'].includes(doc.action);
    return {
      ...doc,
      timestamp: doc.timestamp || doc.createdAt,
      severity: doc.severity || (sensitive ? 'sensitive' : notice ? 'notice' : 'info'),
    };
  });

  return {
    logs,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
  };
};

export const getActivityStatsForBusiness = async (businessId: mongoose.Types.ObjectId, daysParam?: string) => {
  const daysNum = Math.min(365, Math.max(1, parseInt(daysParam || '7') || 7));
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysNum);

  // Schema uses `timestamps: true`, so the event time lives in createdAt.
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
    ActivityLog.aggregate([{ $match: match }, { $group: { _id: '$action', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
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
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    ActivityLog.countDocuments({ ...match, ...SENSITIVE_MATCH }),
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
