import mongoose from 'mongoose';
import RecurringInvoice from '../models/RecurringInvoice.js';
import Invoice from '../models/Invoice.js';
import { generateInvoiceNumber } from './invoiceService.js';
import { runInTransaction } from '../utils/transaction.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';
import { logger } from '../utils/logger.js';

const computeNextRunDate = (
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly',
  from: Date,
  dayOfMonth?: number,
): Date => {
  const next = new Date(from);
  switch (frequency) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      if (dayOfMonth) next.setDate(dayOfMonth);
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      if (dayOfMonth) next.setDate(dayOfMonth);
      break;
    case 'yearly':
      next.setFullYear(next.getFullYear() + 1);
      break;
  }
  return next;
};

export const createRecurringInvoiceForBusiness = async (
  user: IUser,
  params: {
    clientId?: string;
    customClientName?: string;
    recipientEmail?: string;
    lineItems?: { description: string; quantity: number; unitPrice: number; total: number }[];
    tax?: number;
    notes?: string;
    frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    dayOfMonth?: number;
    startDate?: string;
    dueDaysAfter?: number;
  },
) => {
  const {
    clientId, customClientName, recipientEmail, lineItems = [], tax = 0, notes,
    frequency, dayOfMonth, startDate, dueDaysAfter = 7,
  } = params;

  const subtotal = lineItems.reduce((acc, item) => acc + item.total, 0);
  const total = subtotal + subtotal * (tax / 100);
  const firstRun = startDate ? new Date(startDate) : new Date();

  return RecurringInvoice.create({
    businessId: user.businessId,
    clientId: clientId || null,
    customClientName: customClientName || null,
    recipientEmail: recipientEmail || null,
    lineItems,
    subtotal,
    tax,
    total,
    notes,
    frequency,
    dayOfMonth,
    nextRunDate: firstRun,
    isActive: true,
    dueDaysAfter,
  });
};

export const getRecurringInvoicesForBusiness = (businessId: mongoose.Types.ObjectId) =>
  RecurringInvoice.find({ businessId }).populate('clientId', 'name email').sort({ createdAt: -1 });

export const updateRecurringInvoiceForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  body: Record<string, unknown>,
) => {
  const doc = await RecurringInvoice.findOneAndUpdate({ _id: id, businessId }, body, { new: true });
  if (!doc) throw new AppError('Not found', 404);
  return doc;
};

export const deleteRecurringInvoiceForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const doc = await RecurringInvoice.findOneAndDelete({ _id: id, businessId });
  if (!doc) throw new AppError('Not found', 404);
};

/**
 * Generate invoices for all active recurring schedules whose nextRunDate <= now.
 * Updates nextRunDate after each generation. Invoked by the cron scheduler.
 */
export const generateDueRecurringInvoices = async (): Promise<void> => {
  const now = new Date();
  const due = await RecurringInvoice.find({ isActive: true, nextRunDate: { $lte: now } });

  for (const template of due) {
    try {
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + template.dueDaysAfter);

      const invoiceNumber = await generateInvoiceNumber();
      const nextRunDate = computeNextRunDate(template.frequency, now, template.dayOfMonth);

      // Claim this run and create the invoice atomically. The claim only matches
      // if nextRunDate is unchanged, so if the job runs twice (overlapping ticks,
      // several server instances) only one run generates the invoice, and a crash
      // can't leave an invoice without the schedule advancing (or vice versa).
      await runInTransaction(async (session) => {
        const claimed = await RecurringInvoice.findOneAndUpdate(
          { _id: template._id, isActive: true, nextRunDate: template.nextRunDate },
          { $set: { lastRunDate: now, nextRunDate } },
          { session, new: true },
        );
        if (!claimed) return; // another run already handled it

        await Invoice.create(
          [
            {
              businessId: template.businessId,
              clientId: template.clientId || null,
              customClientName: template.customClientName || null,
              recipientEmail: template.recipientEmail || null,
              invoiceNumber,
              lineItems: template.lineItems,
              subtotal: template.subtotal,
              tax: template.tax,
              total: template.total,
              notes: template.notes,
              status: 'draft',
              dueDate,
            },
          ],
          { session },
        );
      });

      logger.info(`[Cron] Generated recurring invoice ${invoiceNumber} for business ${template.businessId}`);
    } catch (err) {
      logger.error(`[Cron] Failed to generate recurring invoice for template ${template._id}:`, err);
    }
  }

  if (due.length > 0) {
    logger.info(`[Cron] Processed ${due.length} recurring invoice templates.`);
  }
};
