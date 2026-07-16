import type { Request, Response } from 'express';
import type mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as notificationService from '../services/notificationService.js';

export { createNotification } from '../services/notificationService.js';

/**
 * @desc    Get all notifications for the logged-in user
 * @route   GET /api/notifications
 * @access  Private
 */
export const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await notificationService.getNotificationsForUser(req.user._id as mongoose.Types.ObjectId);
  res.status(200).json(result);
});

/**
 * @desc    Mark a notification as read
 * @route   PUT /api/notifications/:id/read
 * @access  Private
 */
export const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const notification = await notificationService.markNotificationAsReadForUser(
    req.params.id!,
    req.user._id as mongoose.Types.ObjectId,
  );
  res.status(200).json(notification);
});

/**
 * @desc    Mark all notifications as read
 * @route   PUT /api/notifications/read-all
 * @access  Private
 */
export const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await notificationService.markAllNotificationsAsReadForUser(req.user._id as mongoose.Types.ObjectId);
  res.status(200).json({ message: 'All notifications marked as read' });
});

/**
 * @desc    Delete a notification
 * @route   DELETE /api/notifications/:id
 * @access  Private
 */
export const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await notificationService.deleteNotificationForUser(req.params.id!, req.user._id as mongoose.Types.ObjectId);
  res.status(200).json({ message: 'Notification removed' });
});
