import type { Request, Response } from 'express';
import RecurringInvoice from '../models/RecurringInvoice.js';
import Invoice from '../models/Invoice.js';
import Counter from '../models/Counter.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const generateInvoiceNumber = async (): Promise<string> => {
  const COUNTER_ID = 'invoices';
  const exists = await Counter.exists({ _id: COUNTER_ID });
  if (!exists) {
    const existingCount = await Invoice.countDocuments();
    try {
      await Counter.create({ _id: COUNTER_ID, seq: existingCount });
    } catch (e: any) {
      if (e.code !== 11000) throw e;
    }
  }
  const counter = await Counter.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { new: true },
  );
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

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * @route   POST /api/recurring-invoices
 * @access  Private
 */
export const createRecurringInvoice = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const {
      clientId,
      customClientName,
      recipientEmail,
      lineItems = [],
      tax = 0,
      notes,
      frequency,
      dayOfMonth,
      startDate,
      dueDaysAfter = 7,
    } = req.body;

    const subtotal = lineItems.reduce((acc: number, item: any) => acc + item.total, 0);
    const total = subtotal + subtotal * (tax / 100);

    const firstRun = startDate ? new Date(startDate) : new Date();

    const doc = await RecurringInvoice.create({
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

    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @route   GET /api/recurring-invoices
 * @access  Private
 */
export const getRecurringInvoices = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const docs = await RecurringInvoice.find({ businessId: user.businessId })
      .populate('clientId', 'name email')
      .sort({ createdAt: -1 });
    res.status(200).json(docs);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @route   PUT /api/recurring-invoices/:id
 * @access  Private
 */
export const updateRecurringInvoice = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const doc = await RecurringInvoice.findOneAndUpdate(
      { _id: req.params.id, businessId: user.businessId },
      req.body,
      { new: true },
    );
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.status(200).json(doc);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @route   DELETE /api/recurring-invoices/:id
 * @access  Private
 */
export const deleteRecurringInvoice = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const doc = await RecurringInvoice.findOneAndDelete({ _id: req.params.id, businessId: user.businessId });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.status(200).json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

// ─── Cron runner (called from cronService) ───────────────────────────────────

/**
 * Generate invoices for all active recurring schedules whose nextRunDate <= now.
 * Updates nextRunDate after each generation.
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
