import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as invoiceService from '../services/invoiceService.js';

/**
 * @desc    Scan an invoice using Gemini Vision
 * @route   POST /api/invoices/scan
 * @access  Private
 */
export const scanInvoice = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('No file uploaded.', 400);
  const visionResult = await invoiceService.scanInvoiceImage(req.file.buffer, req.file.mimetype);
  res.status(200).json(visionResult);
});

/**
 * @desc    Create a new invoice
 * @route   POST /api/invoices
 * @access  Private
 */
export const createInvoice = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const createdInvoice = await invoiceService.createInvoice(req.user, req.body);
  res.status(201).json(createdInvoice);
});

/**
 * @desc    Get all invoices for a business
 * @route   GET /api/invoices
 * @access  Private
 */
export const getInvoices = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { page, limit, status, search, clientId } = req.query;
  const result = await invoiceService.getInvoicesForBusiness(req.user.businessId, {
    page: page as string,
    limit: limit as string,
    status: status as string,
    search: search as string,
    clientId: clientId as string,
  });
  res.status(200).json(result);
});

/**
 * @desc    Get a single invoice by ID
 * @route   GET /api/invoices/:id
 * @access  Private
 */
export const getInvoiceById = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const invoice = await invoiceService.getInvoiceByIdForBusiness(req.params.id!, req.user.businessId);
  res.status(200).json(invoice);
});

/**
 * @desc    Update an invoice's status
 * @route   PUT /api/invoices/:id/status
 * @access  Private
 */
export const updateInvoiceStatus = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const updatedInvoice = await invoiceService.updateInvoiceStatusForBusiness(req.params.id!, req.user, req.body.status);
  res.status(200).json(updatedInvoice);
});

/**
 * @desc    Get a single invoice publicly (no auth) — used for client-facing view
 * @route   GET /api/invoices/public/:id
 * @access  Public
 */
export const getPublicInvoice = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await invoiceService.getPublicInvoiceById(req.params.id!);
  res.status(200).json(invoice);
});

/**
 * @desc    Send invoice via email to client
 * @route   POST /api/invoices/:id/send
 * @access  Private
 */
export const sendInvoice = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { email } = req.body;
  if (!email) throw new AppError('Recipient email is required', 400);

  const { sent, publicLink } = await invoiceService.sendInvoiceByEmail(req.params.id!, req.user, email);

  res.status(200).json({
    message: sent
      ? `Invoice emailed to ${email} successfully`
      : 'Email delivery failed — check your SMTP settings on the server. Invoice was still marked as sent.',
    emailSent: sent,
    publicLink,
  });
});

/**
 * @desc    Generate a WhatsApp wa.me link for an invoice
 * @route   POST /api/invoices/:id/whatsapp
 * @access  Private
 */
export const getWhatsAppLink = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { phone } = req.body;
  if (!phone) throw new AppError('Phone number is required', 400);

  const result = await invoiceService.getInvoiceWhatsAppLink(req.params.id!, req.user, phone);
  res.status(200).json(result);
});

/**
 * @desc    Initialize a Paystack payment for an invoice
 * @route   POST /api/invoices/:id/pay/init
 * @access  Public
 */
export const initPaystackPayment = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) throw new AppError('Email is required', 400);
  const result = await invoiceService.initPaystackPaymentForInvoice(req.params.id!, email);
  res.status(200).json(result);
});

/**
 * @desc    Paystack webhook — marks invoice as paid and records income transaction
 * @route   POST /api/webhooks/paystack
 * @access  Public (verified by signature)
 */
export const paystackWebhook = asyncHandler(async (req: Request, res: Response) => {
  try {
    await invoiceService.handlePaystackWebhook(req.body, req.headers['x-paystack-signature']);
  } catch {
    return res.sendStatus(401);
  }
  res.sendStatus(200);
});
