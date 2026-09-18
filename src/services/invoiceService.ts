import mongoose from 'mongoose';
import axios from 'axios';
import crypto from 'crypto';
import Invoice, { type IInvoice } from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import Business from '../models/Business.js';
import Product from '../models/Product.js';
import { createNotification } from '../services/notificationService.js';
import { enqueue } from './exportQueueService.js';
import { fire } from './webhookService.js';
import { emitToBusiness } from './socketService.js';
import { sendInvoiceEmail, sendReceiptEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';
import { extractDocumentText } from '../utils/documentExtraction.js';
import { parseInvoiceText } from '../utils/documentParsing.js';
import type { IUser } from '../models/User.js';

// ─────────────────────────────────────────────────────────────────────────────
// Invoice scanning is deliberately hardcoded, not AI-driven: OCR (images) /
// text-layer extraction (PDFs) via documentExtraction.ts, then regex parsing
// via documentParsing.ts. This used to call Gemini Vision, but a hosted
// model getting deprecated out from under the app (gemini-2.0-flash was
// retired by Google) silently broke scanning for every user with no code
// change on our end. A local, hardcoded pipeline can't be deprecated by a
// third party — the tradeoff is it only recognizes patterns we've explicitly
// written (labeled fields like "Invoice Number:", "Total:", etc.), so an
// invoice with a very unusual layout may come back with gaps rather than
// best-effort guessed.
// ─────────────────────────────────────────────────────────────────────────────

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
  const text = await extractDocumentText(buffer, mimetype);
  const parsed = parseInvoiceText(text);
  if (!parsed) throw new AppError('Could not parse invoice. Please try a clearer image, or check that the total is labeled (e.g. "Total:").', 422);
  return { ...parsed, text };
};

export const createInvoice = async (
  user: IUser,
  params: {
    clientId?: string;
    customClientName?: string;
    lineItems?: { description: string; quantity: number; unitPrice: number; total: number; productId?: string }[];
    tax?: number;
    dueDate?: string;
    notes?: string;
    recordAsIncome?: boolean;
    depositAmount?: number;
  },
) => {
  const { clientId, customClientName, lineItems = [], tax = 0, dueDate: rawDueDate, notes, recordAsIncome, depositAmount } = params;
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

  // depositAmount is the modern path — an explicit amount paid at creation, which
  // can be partial. recordAsIncome is the older "fully paid right now" shortcut,
  // kept working by treating it as a deposit of the full total. Both flow through
  // the same payment logic so the audit log and notification stay consistent no
  // matter how the invoice was born already-paid.
  const initialPayment = depositAmount && depositAmount > 0 ? depositAmount : recordAsIncome ? total : 0;
  let willFullyPay = false;
  if (initialPayment > 0) {
    ({ willFullyPay } = await applyPaymentToInvoice(invoice, user.businessId, user._id as mongoose.Types.ObjectId, {
      amount: initialPayment,
      method: 'manual',
      note: 'Recorded at invoice creation',
    }));
  }

  const createdInvoice = await invoice.save();

  // Stock moves with the invoice itself, same as a receipt — the catalog item
  // left the shelf the moment it was billed, whether or not it's been paid for yet.
  await applyStockForInvoiceLineItems(user.businessId, createdInvoice);

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `New invoice #${createdInvoice.invoiceNumber} created for a total of ${total}.${
      willFullyPay ? ' Paid in full.' : initialPayment > 0 ? ` ${initialPayment} received as a deposit.` : ''
    }`,
    link: `/invoices/${createdInvoice._id}`,
  });

  enqueue({ type: 'invoice', action: 'created', data: createdInvoice.toObject(), businessId: String(user.businessId) });
  fire('invoice.created', String(user.businessId), createdInvoice.toObject());

  return createdInvoice;
};

export const getInvoicesForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { page?: string; limit?: string; status?: string; search?: string; clientId?: string },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (params.status) filter.status = params.status;
  if (params.search) filter.invoiceNumber = { $regex: String(params.search), $options: 'i' };
  if (params.clientId) filter.clientId = params.clientId;

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

// Reduces (or, on void, restores) stock for any catalog items on the invoice.
// The decrement happens once, at invoice creation, regardless of payment
// status — same timing as a receipt. Same "not explicitly false" opt-out and
// allow-negative behavior as receipts.
const applyStockForInvoiceLineItems = async (
  businessId: mongoose.Types.ObjectId,
  invoice: IInvoice,
  direction: 1 | -1 = -1,
) => {
  const items = invoice.lineItems.filter((item) => item.productId && item.quantity);
  if (items.length === 0) return;

  await Promise.all(
    items.map((item) =>
      Product.updateOne(
        { _id: item.productId, businessId, trackStock: true },
        { $inc: { stock: direction * Number(item.quantity) } },
      ),
    ),
  );
};

// Mutates `invoice` in place: validates the amount, creates the income transaction,
// logs it in payments[], and updates status. Does NOT save — the caller saves once
// (so it composes cleanly with invoice creation, which has its own initial save)
// and handles the post-save side effects (stock, notification) since those differ
// slightly between "paying an existing invoice" and "invoice born already paid".
const applyPaymentToInvoice = async (
  invoice: IInvoice,
  businessId: mongoose.Types.ObjectId,
  recordedBy: mongoose.Types.ObjectId | undefined,
  params: { amount: number; method?: string; note?: string },
) => {
  const amount = Number(params.amount);
  if (!amount || amount <= 0) throw new AppError('Enter a valid payment amount', 400);
  if (amount > invoice.balance + 0.01) {
    throw new AppError(`Amount exceeds the remaining balance of ${invoice.balance.toFixed(2)}`, 400);
  }

  const willFullyPay = amount >= invoice.balance - 0.01;

  const incomeTransaction = await Transaction.create({
    clientId: invoice.clientId || null,
    businessId,
    amount,
    type: 'income',
    category: 'Sales',
    description: `Payment received for Invoice #${invoice.invoiceNumber}${willFullyPay ? '' : ' (partial)'}`,
    recordedBy,
    source: 'manual',
  });

  invoice.payments.push({
    amount,
    date: new Date(),
    method: params.method || 'manual',
    transactionId: incomeTransaction._id as mongoose.Types.ObjectId,
    ...(params.note ? { note: params.note } : {}),
  });
  invoice.status = willFullyPay ? 'paid' : 'partial';
  if (willFullyPay && !invoice.transactionId) {
    invoice.transactionId = incomeTransaction._id as mongoose.Types.ObjectId;
  }

  return { willFullyPay, transaction: incomeTransaction };
};

// Records money actually received against an invoice — creates a transaction for
// exactly that amount (not the invoice's face value), logs it in invoice.payments,
// and moves status to 'partial' or 'paid' depending on what's left owing. This is
// the one place that touches the invoice/transaction/payments trio, so every
// payment channel (manual entry, the old "mark as paid" toggle, Paystack) goes
// through it and the ledger always sums to what actually came in.
export const recordPaymentForInvoice = async (
  id: string,
  user: IUser,
  params: { amount: number; method?: string; note?: string },
) => {
  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'paid') throw new AppError('Invoice is already fully paid', 400);
  if (invoice.status === 'void') throw new AppError('This invoice has been voided and can no longer be changed', 400);

  const amount = Number(params.amount);
  const { willFullyPay } = await applyPaymentToInvoice(invoice, user.businessId, user._id as mongoose.Types.ObjectId, params);

  const updatedInvoice = await invoice.save();

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: willFullyPay
      ? `Invoice #${updatedInvoice.invoiceNumber} fully paid — ${amount} received.`
      : `${amount} received on Invoice #${updatedInvoice.invoiceNumber} — ${updatedInvoice.balance} still owing.`,
    link: `/invoices/${updatedInvoice._id}`,
  });

  enqueue({ type: 'invoice', action: 'updated', data: updatedInvoice.toObject(), businessId: String(user.businessId) });
  fire('invoice.updated', String(user.businessId), updatedInvoice.toObject());
  emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'updated' });

  return updatedInvoice;
};

// Removes the most recently recorded payment — deletes its linked transaction
// and drops status back to 'partial' (if other payments remain) or 'sent' (if
// not). Doesn't touch stock: that moved at invoice creation and isn't tied to
// payment status. Only the last payment can be undone, not arbitrary history,
// to avoid the mess of recalculating everything after a payment buried
// earlier in the log.
export const undoLastPaymentForInvoice = async (id: string, user: IUser) => {
  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.payments.length === 0) throw new AppError('This invoice has no recorded payments to undo', 400);

  const lastPayment = invoice.payments[invoice.payments.length - 1]!;
  invoice.payments.pop();

  if (lastPayment.transactionId) {
    await Transaction.findByIdAndDelete(lastPayment.transactionId);
    if (invoice.transactionId && String(invoice.transactionId) === String(lastPayment.transactionId)) {
      invoice.transactionId = undefined;
    }
  }

  invoice.status = invoice.payments.length > 0 ? 'partial' : 'sent';

  const updatedInvoice = await invoice.save();

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `Removed a payment of ${lastPayment.amount} from Invoice #${updatedInvoice.invoiceNumber}.`,
    link: `/invoices/${updatedInvoice._id}`,
  });

  enqueue({ type: 'invoice', action: 'updated', data: updatedInvoice.toObject(), businessId: String(user.businessId) });
  fire('invoice.updated', String(user.businessId), updatedInvoice.toObject());
  emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'updated' });

  return updatedInvoice;
};

export const updateInvoiceStatusForBusiness = async (
  id: string,
  user: IUser,
  status: IInvoice['status'],
) => {
  if (status === 'partial') {
    throw new AppError('Invoices move to "partial" automatically once a payment is recorded against them — use the payments endpoint instead.', 400);
  }

  if (status === 'paid') {
    const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId });
    if (!invoice) throw new AppError('Invoice not found', 404);
    if (invoice.status === 'void') throw new AppError('This invoice has been voided and can no longer be changed', 400);
    if (invoice.balance <= 0) return invoice;
    return recordPaymentForInvoice(id, user, { amount: invoice.balance, method: 'manual' });
  }

  if (status === 'void') {
    return voidInvoiceForBusiness(id, user);
  }

  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'void') throw new AppError('This invoice has been voided and can no longer be changed', 400);

  invoice.status = status;
  const updatedInvoice = await invoice.save();

  enqueue({ type: 'invoice', action: 'updated', data: updatedInvoice.toObject(), businessId: String(user.businessId) });
  fire('invoice.updated', String(user.businessId), updatedInvoice.toObject());
  emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'updated' });

  return updatedInvoice;
};

// Cancels an invoice for good: only allowed when no payments are recorded
// against it (undo those first via the payments endpoint — voiding a partly
// paid invoice would mean silently reversing money someone already received,
// which is a business decision this endpoint shouldn't make on its own).
// Restores whatever stock left the shelf at creation, since the sale never
// actually completed.
export const voidInvoiceForBusiness = async (id: string, user: IUser) => {
  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'void') throw new AppError('Invoice is already void', 400);
  if (invoice.payments.length > 0) {
    throw new AppError('This invoice has payments recorded against it — undo them first, then void.', 400);
  }

  invoice.status = 'void';
  const updatedInvoice = await invoice.save();

  await applyStockForInvoiceLineItems(user.businessId, updatedInvoice, 1);

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `Invoice #${updatedInvoice.invoiceNumber} was voided — stock restored.`,
    link: `/invoices/${updatedInvoice._id}`,
  });

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

  // Charge whatever's actually left owing, not the invoice's face value — matters
  // once part of it has already been paid manually (e.g. a bank transfer logged
  // against the invoice before the client pays the rest online).
  const amountKobo = Math.round(invoice.balance * 100);

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

  const amountCharged = invoice.balance;
  invoice.status = 'paid';

  if (!invoice.transactionId) {
    const tx = await Transaction.create({
      clientId: invoice.clientId || null,
      businessId: invoice.businessId,
      amount: amountCharged,
      type: 'income',
      category: 'Sales',
      description: `Paystack payment for Invoice #${invoice.invoiceNumber}`,
      source: 'manual',
    });
    invoice.transactionId = tx._id as mongoose.Types.ObjectId;
    invoice.payments.push({
      amount: amountCharged,
      date: new Date(),
      method: 'paystack',
      transactionId: tx._id as mongoose.Types.ObjectId,
    });
  }

  await invoice.save();

  const owningBusiness = await Business.findById(invoice.businessId).select('owner');
  if (owningBusiness?.owner) {
    await createNotification({
      businessId: invoice.businessId,
      userId: owningBusiness.owner,
      message: `Invoice #${invoice.invoiceNumber} fully paid via Paystack — ${amountCharged} received.`,
      link: `/invoices/${invoice._id}`,
    });
  }

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
