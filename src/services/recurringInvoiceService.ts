import mongoose from 'mongoose';
import RecurringInvoice from '../models/RecurringInvoice.js';
import Invoice from '../models/Invoice.js';
import Counter from '../models/Counter.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

const generateInvoiceNumber = async (): Promise<string> => {
  const COUNTER_ID = 'invoices';
  const exists = await Counter.exists({ _id: COUNTER_ID });
  if (!exists) {
    const existingCount = await Invoice.countDocuments();
    try {
      await Counter.create({ _id: COUNTER_ID, seq: existingCount });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  const counter = await Counter.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { seq: 1 } }, { new: true });
  return `INV-${counter!.seq.toString().padStart(4, '0')}`;
};

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
      await Invoice.create({
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
      });

      template.lastRunDate = now;
      template.nextRunDate = computeNextRunDate(template.frequency, now, template.dayOfMonth);
      await template.save();

      console.log(`[Cron] Generated recurring invoice ${invoiceNumber} for business ${template.businessId}`);
    } catch (err) {
      console.error(`[Cron] Failed to generate recurring invoice for template ${template._id}:`, err);
    }
  }

  if (due.length > 0) {
    console.log(`[Cron] Processed ${due.length} recurring invoice templates.`);
  }
};
