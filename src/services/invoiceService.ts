import mongoose, { type ClientSession } from 'mongoose';
import axios from 'axios';
import crypto from 'crypto';
import Invoice, { type IInvoice } from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import Business from '../models/Business.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { createNotification } from '../services/notificationService.js';
import { enqueue } from './exportQueueService.js';
import { fire } from './webhookService.js';
import { emitToBusiness } from './socketService.js';
import { sendInvoiceEmail, sendReceiptEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';
import { logoUrlForEmail } from '../utils/branding.js';
import { escapeRegex } from '../utils/regex.js';
import { runInTransaction, isDuplicateKeyError } from '../utils/transaction.js';
import { extractDocumentText } from '../utils/documentExtraction.js';
import { parseInvoiceText } from '../utils/documentParsing.js';
import type { IUser } from '../models/User.js';
import { logger } from '../utils/logger.js';
import { BASE_CURRENCY, resolveEmailCurrency } from '../utils/currency.js';

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
export const generateInvoiceNumber = async (): Promise<string> => {
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
  const total = roundMoney(subtotal + subtotal * (tax / 100));

  const invoiceNumber = await generateInvoiceNumber();

  // depositAmount is the modern path — an explicit amount paid at creation, which
  // can be partial. recordAsIncome is the older "fully paid right now" shortcut,
  // kept working by treating it as a deposit of the full total. Both flow through
  // the same payment logic so the audit log and notification stay consistent no
  // matter how the invoice was born already-paid.
  const initialPayment = depositAmount && depositAmount > 0 ? depositAmount : recordAsIncome ? total : 0;
  let willFullyPay = false;

  // Invoice + deposit transaction commit together, so a crash can't leave an
  // income transaction pointing at an invoice that was never saved. The callback
  // builds everything from scratch because withTransaction may re-run it.
  const createdInvoice = await runInTransaction(async (session) => {
    const invoice = new Invoice({
      businessId: user.businessId,
      clientId: clientId || null,
      customClientName: customClientName || null,
      invoiceNumber,
      lineItems,
      subtotal,
      tax,
      total,
      dueDate,
      notes,
    });
    willFullyPay = false;
    if (initialPayment > 0) {
      ({ willFullyPay } = await applyPaymentToInvoice(
        invoice,
        user.businessId,
        user._id as mongoose.Types.ObjectId,
        { amount: initialPayment, method: 'manual', note: 'Recorded at invoice creation' },
        session,
      ));
    }
    return invoice.save({ session });
  });

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
  if (params.search) filter.invoiceNumber = { $regex: escapeRegex(String(params.search)), $options: 'i' };
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

// Rounds to 2 decimal places. Amounts are stored as numbers, so every payment
// is normalised to whole kobo/cents to stop floating-point drift accumulating.
const roundMoney = (n: number) => Math.round(n * 100) / 100;

// Mutates `invoice` in place: validates the amount, creates the income transaction,
// logs it in payments[], and updates status. Does NOT save — the caller saves once
// (so it composes cleanly with invoice creation, which has its own initial save)
// and handles the post-save side effects (stock, notification) since those differ
// slightly between "paying an existing invoice" and "invoice born already paid".
// Pass the caller's `session` so the transaction and invoice commit atomically.
const applyPaymentToInvoice = async (
  invoice: IInvoice,
  businessId: mongoose.Types.ObjectId,
  recordedBy: mongoose.Types.ObjectId | undefined,
  params: { amount: number; method?: string; note?: string; reference?: string },
  session?: ClientSession,
) => {
  const amount = roundMoney(Number(params.amount));
  if (!amount || amount <= 0) throw new AppError('Enter a valid payment amount', 400);
  if (amount > invoice.balance + 0.01) {
    throw new AppError(`Amount exceeds the remaining balance of ${invoice.balance.toFixed(2)}`, 400);
  }

  const willFullyPay = amount >= invoice.balance - 0.01;

  const [incomeTransaction] = await Transaction.create(
    [
      {
        clientId: invoice.clientId || null,
        businessId,
        amount,
        type: 'income',
        category: 'Sales',
        description: `Payment received for Invoice #${invoice.invoiceNumber}${willFullyPay ? '' : ' (partial)'}`,
        recordedBy,
        source: 'manual',
        // A gateway reference doubles as an idempotency key: the unique
        // {businessId, externalSource, externalId} index rejects a second
        // transaction for the same provider payment (see models/Transaction.ts).
        ...(params.reference ? { externalSource: params.method || 'gateway', externalId: params.reference } : {}),
      },
    ],
    { session },
  );

  invoice.payments.push({
    amount,
    date: new Date(),
    method: params.method || 'manual',
    transactionId: incomeTransaction!._id as mongoose.Types.ObjectId,
    ...(params.note ? { note: params.note } : {}),
    ...(params.reference ? { reference: params.reference } : {}),
  });
  invoice.status = willFullyPay ? 'paid' : 'partial';
  if (willFullyPay && !invoice.transactionId) {
    invoice.transactionId = incomeTransaction!._id as mongoose.Types.ObjectId;
  }

  return { willFullyPay, amount, transaction: incomeTransaction! };
};

// Records money actually received against an invoice — creates a transaction for
// exactly that amount (not the invoice's face value), logs it in invoice.payments,
// and moves status to 'partial' or 'paid' depending on what's left owing. This is
// the one place that touches the invoice/transaction/payments trio, so every
// payment channel (manual entry, the "mark as paid" toggle, the Paystack webhook)
// goes through it and the ledger always sums to what actually came in.
export const recordPaymentForInvoice = async (
  id: string,
  user: IUser,
  params: { amount: number; method?: string; note?: string },
) => {
  let willFullyPay = false;
  let amount = 0;

  // Read, validate and write inside one transaction: two concurrent payments
  // can't both pass the balance check — the loser hits a write conflict, is
  // re-run by withTransaction, and then sees the updated balance.
  const updatedInvoice = await runInTransaction(async (session) => {
    const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId }).session(session);
    if (!invoice) throw new AppError('Invoice not found', 404);
    if (invoice.status === 'paid') throw new AppError('Invoice is already fully paid', 400);
    if (invoice.status === 'void') throw new AppError('This invoice has been voided and can no longer be changed', 400);

    ({ willFullyPay, amount } = await applyPaymentToInvoice(
      invoice,
      user.businessId,
      user._id as mongoose.Types.ObjectId,
      params,
      session,
    ));
    return invoice.save({ session });
  });

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
  let lastPayment: IInvoice['payments'][number] | undefined;

  // Deleting the transaction and popping the payment happen atomically, so the
  // ledger and the invoice can't disagree if the process dies in between.
  const updatedInvoice = await runInTransaction(async (session) => {
    const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId }).session(session);
    if (!invoice) throw new AppError('Invoice not found', 404);
    if (invoice.payments.length === 0) throw new AppError('This invoice has no recorded payments to undo', 400);

    lastPayment = invoice.payments[invoice.payments.length - 1]!;
    invoice.payments.pop();

    if (lastPayment.transactionId) {
      await Transaction.findOneAndDelete({ _id: lastPayment.transactionId, businessId: user.businessId }, { session });
      if (invoice.transactionId && String(invoice.transactionId) === String(lastPayment.transactionId)) {
        invoice.transactionId = undefined;
      }
    }

    invoice.status = invoice.payments.length > 0 ? 'partial' : 'sent';
    return invoice.save({ session });
  });

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `Removed a payment of ${lastPayment!.amount} from Invoice #${updatedInvoice.invoiceNumber}.`,
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
      'name currency profile.logoImage profile.accentColor profile.email profile.whatsapp profile.location profile.bankName profile.accountNumber profile.accountName profile.bankName2 profile.accountNumber2 profile.accountName2',
    );
  if (!invoice) throw new AppError('Invoice not found', 404);
  return invoice;
};

// `currency` is the one the sender has selected in the app; amounts are stored in
// NGN, so they are converted the same way the screen converts them.
export const sendInvoiceByEmail = async (id: string, user: IUser, email: string, currency?: unknown) => {
  const invoice = await Invoice.findOne({ _id: id, businessId: user.businessId }).populate<{
    clientId: { name: string; email: string } | null;
  }>('clientId', 'name email');
  if (!invoice) throw new AppError('Invoice not found', 404);

  const business = await Business.findById(user.businessId);
  const clientName = invoice.clientId ? invoice.clientId.name : invoice.customClientName || 'Valued Client';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const publicLink = `${frontendUrl}/invoice/${invoice._id}`;

  const cur = resolveEmailCurrency(currency);

  const sent = await sendInvoiceEmail({
    invoiceNumber: invoice.invoiceNumber,
    businessName: business?.name || 'OpsFlow Business',
    clientName,
    recipientEmail: email,
    total: cur.convert(invoice.total),
    currency: cur.code,
    dueDate: invoice.dueDate.toISOString(),
    lineItems: invoice.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPrice: cur.convert(li.unitPrice),
      total: cur.convert(li.total),
    })),
    subtotal: cur.convert(invoice.subtotal),
    tax: invoice.tax,
    notes: invoice.notes,
    publicLink,
    logoUrl: logoUrlForEmail(business),
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
  const invoice = await Invoice.findById(id);
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'paid') throw new AppError('Invoice is already paid', 400);
  if (invoice.status === 'void') throw new AppError('This invoice has been voided', 400);

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) throw new AppError('Payment not configured on this server', 503);

  // Charge whatever's actually left owing, not the invoice's face value — matters
  // once part of it has already been paid manually (e.g. a bank transfer logged
  // against the invoice before the client pays the rest online).
  const amountMinor = Math.round(invoice.balance * 100);


  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amountMinor,
        currency: PAYSTACK_CURRENCY,
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

// Amounts are stored in the app's base currency (NGN — CurrencyContext converts
// from it for display), so online payments are always charged in NGN. Sent
// explicitly rather than relying on the Paystack account default, and checked
// again on the webhook.
const PAYSTACK_CURRENCY = 'NGN';

// Constant-time comparison so the signature check doesn't leak how many
// leading characters matched.
const signaturesMatch = (expected: string, received: unknown): boolean => {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
};

interface PaystackChargeEvent {
  event?: string;
  data?: {
    reference?: string;
    status?: string;
    amount?: number; // minor units (kobo / cents)
    currency?: string;
    metadata?: { invoice_id?: string };
  };
}

export type PaystackWebhookResult = 'processed' | 'duplicate' | 'ignored';

/**
 * Handles a Paystack webhook. Safe to receive the same event any number of
 * times, concurrently or not — Paystack delivers "at least once".
 *
 * 1. Verify HMAC-SHA512 over the RAW body bytes (not re-serialised JSON — the
 *    body sanitiser used to alter the parsed body, breaking valid signatures).
 * 2. Ignore anything but a successful charge for an invoice we know.
 * 3. Record the amount Paystack actually charged — not the invoice balance —
 *    through the same applyPaymentToInvoice path as manual payments.
 * 4. Idempotency: the Paystack reference is stored on the payment and as the
 *    income transaction's externalId (unique index). A duplicate delivery either
 *    sees the reference already recorded, or loses the race on the unique index.
 */
export const handlePaystackWebhook = async (
  rawBody: Buffer | undefined,
  signature: unknown,
): Promise<PaystackWebhookResult> => {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) throw new AppError('Payment not configured on this server', 503);
  if (!rawBody) throw new AppError('Missing body', 400);

  const expected = crypto.createHmac('sha512', paystackKey).update(rawBody).digest('hex');
  if (!signaturesMatch(expected, signature)) throw new AppError('Invalid signature', 401);

  let event: PaystackChargeEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as PaystackChargeEvent;
  } catch {
    throw new AppError('Malformed payload', 400);
  }

  const data = event.data;
  if (event.event !== 'charge.success' || data?.status !== 'success') return 'ignored';
  const invoiceId = data.metadata?.invoice_id;
  const reference = data.reference;
  if (!invoiceId || !reference || !mongoose.isValidObjectId(invoiceId)) return 'ignored';

  // Assigned inside the transaction callback, so widen it explicitly.
  let outcome = 'ignored' as PaystackWebhookResult;
  let recordedAmount = 0;
  let willFullyPay = false;

  try {
    await runInTransaction(async (session) => {
      outcome = 'ignored';
      const invoice = await Invoice.findById(invoiceId).session(session);
      if (!invoice || invoice.status === 'void') return;

      if (invoice.payments.some((p) => p.reference === reference)) {
        outcome = 'duplicate';
        return;
      }

      if (data.currency && data.currency.toUpperCase() !== PAYSTACK_CURRENCY) {
        logger.error(`[Paystack] Currency mismatch on ${reference}: got ${data.currency}, expected ${PAYSTACK_CURRENCY}`);
        return;
      }
      const business = await Business.findById(invoice.businessId).select('owner').session(session);

      const charged = Math.round(Number(data.amount || 0)) / 100;
      if (charged <= 0) return;

      // Money arrived even if the invoice was settled some other way in the
      // meantime; record what fits and flag any excess for the owner.
      const balance = invoice.balance;
      if (balance <= 0) {
        logger.error(`[Paystack] ${reference}: ${charged} received for already-settled invoice ${invoice.invoiceNumber}`);
        return;
      }
      const amount = Math.min(charged, balance);
      const overpaid = roundMoney(charged - amount);

      // Transactions require a recorder — attribute gateway payments to the owner
      // (or any admin if the business has no owner recorded).
      const recorder =
        business?.owner ??
        ((await User.findOne({ businessId: invoice.businessId, role: 'admin' }).select('_id').session(session))
          ?._id as mongoose.Types.ObjectId | undefined);

      ({ willFullyPay, amount: recordedAmount } = await applyPaymentToInvoice(
        invoice,
        invoice.businessId,
        recorder,
        {
          amount,
          method: 'paystack',
          reference,
          ...(overpaid > 0 ? { note: `Overpaid by ${overpaid} via Paystack — refund or credit the client` } : {}),
        },
        session,
      ));
      await invoice.save({ session });
      outcome = 'processed';
    });
  } catch (e) {
    // A concurrent delivery of the same event won the race on the unique
    // {businessId, externalSource, externalId} index — already recorded.
    if (isDuplicateKeyError(e)) return 'duplicate';
    throw e;
  }

  if (outcome !== 'processed') return outcome;

  // Side effects only after the commit, so a retried transaction can't notify twice.
  const populated = await Invoice.findById(invoiceId)
    .populate<{
      businessId: {
        _id: mongoose.Types.ObjectId;
        name: string;
        currency: string;
        owner?: mongoose.Types.ObjectId;
        updatedAt?: Date;
        profile?: { logoImage?: string; accentColor?: string };
      } | null;
    }>(
      'businessId',
      'name currency owner profile.logoImage profile.accentColor updatedAt',
    )
    .populate<{ clientId: { name: string; email: string } | null }>('clientId', 'name email');
  const biz = populated?.businessId;
  if (!populated || !biz) return outcome;

  if (biz.owner) {
    await createNotification({
      businessId: biz._id,
      userId: biz.owner,
      message: willFullyPay
        ? `Invoice #${populated.invoiceNumber} fully paid via Paystack — ${recordedAmount} received.`
        : `${recordedAmount} received via Paystack on Invoice #${populated.invoiceNumber} — ${populated.balance} still owing.`,
      link: `/invoices/${populated._id}`,
    });
  }

  emitToBusiness(String(biz._id), 'data_updated', { type: 'invoice', action: 'paid' });

  const client = populated.clientId;
  const recipientEmail = client?.email || populated.recipientEmail;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  if (recipientEmail && willFullyPay) {
    sendReceiptEmail({
      recipientEmail,
      clientName: client?.name || 'Valued Client',
      businessName: biz.name,
      invoiceNumber: populated.invoiceNumber,
      total: populated.total,
      currency: BASE_CURRENCY,
      paidAt: new Date().toISOString(),
      publicLink: `${frontendUrl}/invoice/${populated._id}`,
      logoUrl: logoUrlForEmail(biz),
      accentColor: biz.profile?.accentColor,
    }).catch(() => {});
  }

  return outcome;
};
