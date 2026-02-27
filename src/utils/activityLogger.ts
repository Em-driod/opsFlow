import type { Request } from 'express';
import ActivityLog from '../models/ActivityLog.js';

interface LogActivityParams {
  req: Request;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'VIEW';
  resource: 'USER' | 'CLIENT' | 'TRANSACTION' | 'INVOICE' | 'BUSINESS' | 'PAYROLL';
  resourceId?: string;
  details?: any;
}

export const logActivity = async ({
  req,
  action,
  resource,
  resourceId,
  details
}: LogActivityParams) => {
  try {
    if (!req.user) {
      console.warn('Cannot log activity: No authenticated user');
      return;
    }

    const activityLog = new ActivityLog({
      user: req.user._id,
      userName: req.user.name,
      userEmail: req.user.email,
      action,
      resource,
      resourceId,
      details,
      businessId: req.user.businessId,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent'),
    });

    await activityLog.save();
  } catch (error) {
    console.error('Failed to log activity:', error);
    // Don't throw error - logging should not break the main functionality
  }
};
