import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import { AppError } from '../utils/AppError.js';

interface CreateNotificationParams {
  businessId: mongoose.Types.ObjectId | string;
  userId: mongoose.Types.ObjectId | string;
  message: string;
  link?: string;
}

export const createNotification = async ({ businessId, userId, message, link }: CreateNotificationParams) => {
  try {
    const notification = new Notification({ businessId, userId, message, link });
    await notification.save();
  } catch (error) {
    console.error('Error creating notification:', error);
    // Don't throw error back to the caller, just log it
  }
};

export const getNotificationsForUser = async (userId: mongoose.Types.ObjectId) => {
  const notifications = await Notification.find({ userId }).sort({ createdAt: -1 }).limit(20);
  const unreadCount = await Notification.countDocuments({ userId, isRead: false });
  return { notifications, unreadCount };
};

export const markNotificationAsReadForUser = async (id: string, userId: mongoose.Types.ObjectId) => {
  const notification = await Notification.findOneAndUpdate({ _id: id, userId }, { isRead: true }, { new: true });
  if (!notification) throw new AppError('Notification not found', 404);
  return notification;
};

export const markAllNotificationsAsReadForUser = (userId: mongoose.Types.ObjectId) =>
  Notification.updateMany({ userId, isRead: false }, { isRead: true });

export const deleteNotificationForUser = async (id: string, userId: mongoose.Types.ObjectId) => {
  const notification = await Notification.findOneAndDelete({ _id: id, userId });
  if (!notification) throw new AppError('Notification not found', 404);
  return notification;
};
