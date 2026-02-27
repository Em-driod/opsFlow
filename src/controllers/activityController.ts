import type { Request, Response } from 'express';
import ActivityLog from '../models/ActivityLog.js';

// @desc    Get activity logs for a business
// @route   GET /api/activity
// @access  Private/Admin
export const getActivityLogs = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const { page = 1, limit = 50, action, resource, userId } = req.query;
    
    // Build query
    const query: any = { businessId: req.user.businessId };
    
    if (action) query.action = action;
    if (resource) query.resource = resource;
    if (userId) query.user = userId;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const logs = await ActivityLog.find(query)
      .populate('user', 'name email')
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limitNum);

    const total = await ActivityLog.countDocuments(query);

    res.json({
      logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error });
  }
};

// @desc    Get activity statistics
// @route   GET /api/activity/stats
// @access  Private/Admin
export const getActivityStats = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const { days = 7 } = req.query;
    const daysNum = parseInt(days as string);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const stats = await ActivityLog.aggregate([
      {
        $match: {
          businessId: req.user.businessId,
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            action: '$action',
            resource: '$resource'
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.resource',
          actions: {
            $push: {
              action: '$_id.action',
              count: '$count'
            }
          },
          total: { $sum: '$count' }
        }
      }
    ]);

    const userActivity = await ActivityLog.aggregate([
      {
        $match: {
          businessId: req.user.businessId,
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: '$user',
          userName: { $first: '$userName' },
          userEmail: { $first: '$userEmail' },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      resourceStats: stats,
      userActivity,
      period: `${daysNum} days`
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error });
  }
};
