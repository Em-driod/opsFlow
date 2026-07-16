import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as recurringInvoiceService from '../services/recurringInvoiceService.js';

/**
 * @route   POST /api/recurring-invoices
 * @access  Private
 */
export const createRecurringInvoice = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const doc = await recurringInvoiceService.createRecurringInvoiceForBusiness(req.user, req.body);
  res.status(201).json(doc);
});

/**
 * @route   GET /api/recurring-invoices
 * @access  Private
 */
export const getRecurringInvoices = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const docs = await recurringInvoiceService.getRecurringInvoicesForBusiness(req.user.businessId);
  res.status(200).json(docs);
});

/**
 * @route   PUT /api/recurring-invoices/:id
 * @access  Private
 */
export const updateRecurringInvoice = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const doc = await recurringInvoiceService.updateRecurringInvoiceForBusiness(req.params.id!, req.user.businessId, req.body);
  res.status(200).json(doc);
});

/**
 * @route   DELETE /api/recurring-invoices/:id
 * @access  Private
 */
export const deleteRecurringInvoice = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await recurringInvoiceService.deleteRecurringInvoiceForBusiness(req.params.id!, req.user.businessId);
  res.status(200).json({ message: 'Deleted' });
});
