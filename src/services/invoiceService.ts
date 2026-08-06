import mongoose from 'mongoose';
import axios from 'axios';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Invoice, { type IInvoice } from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import Business from '../models/Business.js';
import { createNotification } from '../services/notificationService.js';
import { enqueue } from './exportQueueService.js';
import { fire } from './webhookService.js';
import { emitToBusiness } from './socketService.js';
import { sendInvoiceEmail, sendReceiptEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

// ─────────────────────────────────────────────────────────────────────────────
// INVOICE OCR UPGRADE: Gemini Vision replacing Tesseract + multi-regex
//
// The previous implementation used Tesseract + 5 separate regex functions
// (extractAmounts, extractDate, extractTax, extractLineItems, extractInvoiceNumber).
// This was extremely brittle — a single design variation in an invoice layout
// would cause the wrong total to be picked, no date to be found, or line
// items to be silently dropped.
//
// Gemini Vision reads the invoice like a human would, understands context,
// and returns a structured JSON object in one call. No regex involved.
// ─────────────────────────────────────────────────────────────────────────────

const INVOICE_VISION_PROMPT = `
You are a professional invoice parser. Examine the attached invoice image carefully.
Extract the following information and return ONLY a valid JSON object — no markdown wrappers:
{
  "invoiceNumber": "string or null",
  "vendorName": "string or null",
  "clientName": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "subtotal": number or null,
  "tax": number or null,
  "total": number (required — your best estimate if not clearly labelled),
  "currency": "USD" | "GBP" | "EUR" | "NGN" | "other",
  "lineItems": [
    { "description": "string", "quantity": number, "price": number, "total": number }
  ]
}
If a lineItems section is not visible, derive one item from the total.
Always return valid JSON. Never null out the \"total\" field.
`;

const extractInvoiceWithVision = async (buffer: Buffer, mimeType: string): Promise<unknown | null> => {
  if (!apiKey) return null;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent([
      INVOICE_VISION_PROMPT,
      { inlineData: { data: buffer.toString('base64'), mimeType } },
    ]);
    const raw = result.response
      .text()
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('[InvoiceVision] Extraction failed:', err);
    return null;
  }
};

/**
 * Opaque, non-sequential invoice number: date-stamped + random suffix.
 * A sequential counter (INV-0001, INV-0002...) would leak how many invoices
 * a business has issued to anyone who sees one. Mirrors the receipt-number
 * scheme in receiptService.ts.
 */
const generateInvoiceNumber = async (): Promise<string> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars
    const invoiceNumber = `INV-${datePart}-${randomPart}`;
    const exists = await Invoice.exists({ invoiceNumber });
    if (!exists) return invoiceNumber;
  }
  throw new AppError('Could not generate a unique invoice number, please try again', 500);
};

export const scanInvoiceImage = async (buffer: Buffer, mimetype: string) => {
  const visionResult = await extractInvoiceWithVision(buffer, mimetype);
  if (!visionResult) throw new AppError('Could not parse invoice. Please try a clearer image.', 422);
  return visionResult;
};

export const createInvoice = async (
  user: IUser,
  params: {
    clientId?: string;
    customClientName?: string;
    lineItems?: { description: string; quantity: number; unitPrice: number; total: number }[];
    tax?: number;
    dueDate?: string;
    notes?: string;
    recordAsIncome?: boolean;
  },
) => {
  const { clientId, customClientName, lineItems = [], tax = 0, dueDate: rawDueDate, notes, recordAsIncome } = params;
  const dueDate = rawDueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const subtotal = lineItems.reduce((acc, item) => acc + item.total, 0);
  const total = subtotal + subtotal * (tax / 100);

  const invoice = new Invoice({
    businessId: user.businessId,
    clientId: clientId || null,
    customClientName: customClientName || null,
    invoiceNumber: await generateInvoiceNumber(),
    lineItems,
    subtotal,
    tax,
    total,
    dueDate,
    notes,
  });

  if (recordAsIncome) {
    const incomeTransaction = await Transaction.create({
      clientId: clientId || null,
      businessId: user.businessId,
      amount: total,
      type: 'income',
      category: 'Sales',
      description: `Payment for Invoice #${invoice.invoiceNumber}${customClientName ? ` (${customClientName})` : ''}`,
      recordedBy: user._id,
    });

    invoice.transactionId = incomeTransaction._id as mongoose.Types.ObjectId;
    invoice.status = 'paid';
  }

  const createdInvoice = await invoice.save();

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `New invoice #${createdInvoice.invoiceNumber} created for a total of ${total}.${recordAsIncome ? ' Recorded as income.' : ''}`,
    link: `/invoices/${createdInvoice._id}`,
  });

  enqueue({ type: 'invoice', action: 'created', data: createdInvoice.toObject(), businessId: String(user.businessId) });
  fire('invoice.created', String(user.businessId), createdInvoice.toObject());

  return createdInvoice;
};

export const getInvoicesForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { page?: string; limit?: string; status?: string; search?: string },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (params.status) filter.status = params.status;
  if (params.search) filter.invoiceNumber = { $regex: String(params.search), $options: 'i' };

  const pageNum = Math.max(1, parseInt(String(params.page || '1')));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(params.limit || '50'))));
  const skip = (pageNum - 1) * pageSize;

  const [invoices, total] = await Promise.all([
    Invoice.find(filter).populate('clientId', 'name email phone').sort({ createdAt: -1 }).skip(skip).limit(pageSize),
    Invoice.countDocuments(filter),
  ]);
  return { data: invoices, total, page: pageNum, pages: Math.ceil(total / pageSize) };
};

export const getInvoiceByIdForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const invoice = await Invoice.findOne({ _id: id, businessId }).populate('clientId', 'name email phone');
  if (!invoice) throw new AppError('Invoice not found', 404);
  return invoice;
};

export const updateInvoiceStatusForBusiness = async (
  id: string,
  user: IUser,
  status: IInvoice['status'],
) => {
  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId });
  if (!invoice) throw new AppError('Invoice not found', 404);

  invoice.status = status;

  // Create an income transaction the first time an invoice transitions to paid.
  // Guard: skip if a transaction was already created at invoice-creation time.
  if (status === 'paid' && !invoice.transactionId) {
    const incomeTransaction = await Transaction.create({
      clientId: invoice.clientId || null,
      businessId: invoice.businessId,
      amount: invoice.total,
      type: 'income',
      category: 'Sales',
      description: `Payment received for Invoice #${invoice.invoiceNumber}`,
      recordedBy: user._id,
      source: 'manual',
    });
    invoice.transactionId = incomeTransaction._id as mongoose.Types.ObjectId;
  }

  const updatedInvoice = await invoice.save();

  enqueue({ type: 'invoice', action: 'updated', data: updatedInvoice.toObject(), businessId: String(user.businessId) });
  fire('invoice.updated', String(user.businessId), updatedInvoice.toObject());
  emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'updated' });

  return updatedInvoice;
};

export const getPublicInvoiceById = async (id: string) => {
  const invoice = await Invoice.findById(id)
    .populate('clientId', 'name email')
    .populate(
      'businessId',
      'name currency profile.bankName profile.accountNumber profile.accountName profile.bankName2 profile.accountNumber2 profile.accountName2',
    );
  if (!invoice) throw new AppError('Invoice not found', 404);
  return invoice;
};

export const sendInvoiceByEmail = async (id: string, user: IUser, email: string) => {
  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId }).populate<{
    clientId: { name: string; email: string } | null;
  }>('clientId', 'name email');
  if (!invoice) throw new AppError('Invoice not found', 404);

  const business = await Business.findById(user.businessId);
  const clientName = invoice.clientId ? invoice.clientId.name : invoice.customClientName || 'Valued Client';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const publicLink = `${frontendUrl}/invoice/${invoice._id}`;

  const sent = await sendInvoiceEmail({
    invoiceNumber: invoice.invoiceNumber,
    businessName: business?.name || 'OpsFlow Business',
    clientName,
    recipientEmail: email,
    total: invoice.total,
    currency: business?.currency || 'USD',
    dueDate: invoice.dueDate.toISOString(),
    lineItems: invoice.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      total: li.total,
    })),
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    notes: invoice.notes,
    publicLink,
  });

  invoice.recipientEmail = email;
  if (invoice.status === 'draft') invoice.status = 'sent';
  await invoice.save();

  emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'sent' });

  return { sent, publicLink };
};

export const getInvoiceWhatsAppLink = async (id: string, user: IUser, phone: string) => {
  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId }).populate<{
    clientId: { name: string } | null;
  }>('clientId', 'name');
  if (!invoice) throw new AppError('Invoice not found', 404);

  const business = await Business.findById(user.businessId);
  const clientName = invoice.clientId ? invoice.clientId.name : invoice.customClientName || 'there';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const publicLink = `${frontendUrl}/invoice/${invoice._id}`;
  const dueDate = new Date(invoice.dueDate).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const formattedAmount = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
  }).format(invoice.total);

  const message =
    `Hello ${clientName} 👋\n\n` +
    `You have a new invoice from *${business?.name || 'us'}*.\n\n` +
    `📄 *Invoice:* ${invoice.invoiceNumber}\n` +
    `💰 *Amount Due:* ${formattedAmount}\n` +
    `📅 *Due Date:* ${dueDate}\n\n` +
    `Click the link below to view your invoice and pay securely online:\n` +
    `👉 ${publicLink}\n\n` +
    `Reply to this message if you have any questions.\n\n` +
    `Thank you! 🙏\n*${business?.name || 'us'}*`;

  const cleanPhone = phone.replace(/\D/g, '');
  const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;

  if (invoice.status === 'draft') {
    invoice.status = 'sent';
    await invoice.save();
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'sent' });
  }

  return { waUrl, message, publicLink };
};

export const initPaystackPaymentForInvoice = async (id: string, email: string) => {
  const invoice = await Invoice.findById(id).populate('businessId', 'currency');
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'paid') throw new AppError('Invoice is already paid', 400);

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) throw new AppError('Payment not configured on this server', 503);

  const amountKobo = Math.round(invoice.total * 100);

  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amountKobo,
        reference: `INV-${invoice._id}-${Date.now()}`,
        metadata: { invoice_id: String(invoice._id), invoice_number: invoice.invoiceNumber },
        callback_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/invoice/${invoice._id}?paid=true`,
      },
      { headers: { Authorization: `Bearer ${paystackKey}`, 'Content-Type': 'application/json' } },
    );

    return {
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    };
  } catch (error) {
    const msg =
      (error as { response?: { data?: { message?: string } } })?.response?.data?.message ||
      (error as Error).message;
    throw new AppError(msg, 500);
  }
};

export const handlePaystackWebhook = async (rawBody: unknown, signature: unknown) => {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) return;

  const hash = crypto.createHmac('sha512', paystackKey).update(JSON.stringify(rawBody)).digest('hex');
  if (hash !== signature) throw new AppError('Invalid signature', 401);

  const event = rawBody as { event?: string; data?: { metadata?: { invoice_id?: string } } };
  if (event.event !== 'charge.success') return;

  const invoiceId = event.data?.metadata?.invoice_id;
  if (!invoiceId) return;

  const invoice = await Invoice.findById(invoiceId);
  if (!invoice || invoice.status === 'paid') return;

  invoice.status = 'paid';

  if (!invoice.transactionId) {
    const tx = await Transaction.create({
      clientId: invoice.clientId || null,
      businessId: invoice.businessId,
      amount: invoice.total,
      type: 'income',
      category: 'Sales',
      description: `Paystack payment for Invoice #${invoice.invoiceNumber}`,
      source: 'manual',
    });
    invoice.transactionId = tx._id as mongoose.Types.ObjectId;
  }

  await invoice.save();
  emitToBusiness(String(invoice.businessId), 'data_updated', { type: 'invoice', action: 'paid' });

  const populated = await Invoice.findById(invoiceId)
    .populate<{ businessId: { name: string; currency: string } | null }>('businessId', 'name currency')
    .populate<{ clientId: { name: string; email: string } | null }>('clientId', 'name email');
  const biz = populated?.businessId;
  const client = populated?.clientId;
  const recipientEmail = client?.email || invoice.recipientEmail;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  if (recipientEmail && biz) {
    sendReceiptEmail({
      recipientEmail,
      clientName: client?.name || 'Valued Client',
      businessName: biz.name,
      invoiceNumber: invoice.invoiceNumber,
      total: invoice.total,
      currency: biz.currency || 'NGN',
      paidAt: new Date().toISOString(),
      publicLink: `${frontendUrl}/invoice/${invoice._id}`,
    }).catch(() => {});
  }
};
