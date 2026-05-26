import type { Request, Response } from 'express';
import Invoice from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import Business from '../models/Business.js';
import Client from '../models/Client.js';
import Counter from '../models/Counter.js';
import { createNotification } from './notificationController.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { enqueue } from '../services/exportQueueService.js';
import { fire } from '../services/webhookService.js';
import { emitToBusiness } from '../services/socketService.js';
import { sendInvoiceEmail } from '../services/emailService.js';
import axios from 'axios';
import crypto from 'crypto';

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

const extractInvoiceWithVision = async (
  buffer: Buffer,
  mimeType: string
): Promise<any | null> => {
  if (!apiKey) return null;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent([
      INVOICE_VISION_PROMPT,
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: mimeType as any,
        },
      },
    ]);
    const raw = result.response.text().trim()
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
 * @desc    Generate a unique invoice number using an atomic counter.
 *          On first use, seeds the counter from the existing invoice count
 *          so numbers never collide with pre-existing records.
 */
const generateInvoiceNumber = async (): Promise<string> => {
  const COUNTER_ID = 'invoices';

  // Seed the counter once from actual invoice count so existing records are safe.
  const exists = await Counter.exists({ _id: COUNTER_ID });
  if (!exists) {
    const existingCount = await Invoice.countDocuments();
    try {
      await Counter.create({ _id: COUNTER_ID, seq: existingCount });
    } catch (e: any) {
      // Another concurrent request seeded it first — that is fine, carry on.
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

/**
 * @desc    Create a new invoice
 * @route   POST /api/invoices
 * @access  Private
 */
export const createInvoice = async (req: Request, res: Response) => {
  try {
    const { 
      clientId, 
      customClientName, 
      lineItems = [], 
      tax = 0, 
      dueDate, 
      notes, 
      recordAsIncome 
    } = req.body;
    const user = req.user as any;

    const subtotal = lineItems.reduce((acc: number, item: any) => acc + item.total, 0);
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

      invoice.transactionId = incomeTransaction._id as any;
      invoice.status = 'paid';
    }

    const createdInvoice = await invoice.save();

    await createNotification({
      businessId: user.businessId,
      userId: user._id,
      message: `New invoice #${createdInvoice.invoiceNumber} created for a total of ${total}.${recordAsIncome ? ' Recorded as income.' : ''}`,
      link: `/invoices/${createdInvoice._id}`,
    });

    // 🔄 Auto-sync to Google Sheets + fire webhook
    enqueue({ type: 'invoice', action: 'created', data: createdInvoice.toObject(), businessId: String(user.businessId) });
    fire('invoice.created', String(user.businessId), createdInvoice.toObject());

    res.status(201).json(createdInvoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Scan an invoice using Gemini Vision
 * @route   POST /api/invoices/scan
 * @access  Private
 */
export const scanInvoice = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const visionResult = await extractInvoiceWithVision(req.file.buffer, req.file.mimetype);

    if (!visionResult) {
      return res.status(422).json({
        message: 'Could not parse invoice. Please try a clearer image.',
      });
    }

    res.status(200).json(visionResult);
  } catch (error) {
    res.status(500).json({ message: 'Error scanning invoice', error: (error as Error).message });
  }
};

/**
 * @desc    Get all invoices for a business
 * @route   GET /api/invoices
 * @access  Private
 */
export const getInvoices = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const invoices = await Invoice.find({ 
      businessId: user.businessId,
      // Add a field to track which user created the invoice
      // For now, we'll assume all invoices are visible to all business users
      // In a real system, you might want to add a 'createdBy' field to invoices
    })
      .populate('clientId', 'name email phone')
      .sort({ createdAt: -1 });
    res.status(200).json(invoices);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Get a single invoice by ID
 * @route   GET /api/invoices/:id
 * @access  Private
 */
export const getInvoiceById = async (req: Request, res: Response) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    }).populate('clientId', 'name email phone');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Update an invoice's status
 * @route   PUT /api/invoices/:id/status
 * @access  Private
 */
export const updateInvoiceStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const user = req.user as any;

    // Fetch first so we can inspect current state before mutating.
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      businessId: user.businessId,
    });

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

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
      invoice.transactionId = incomeTransaction._id as any;
    }

    const updatedInvoice = await invoice.save();

    enqueue({ type: 'invoice', action: 'updated', data: updatedInvoice.toObject(), businessId: String(user.businessId) });
    fire('invoice.updated', String(user.businessId), updatedInvoice.toObject());
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'updated' });

    res.status(200).json(updatedInvoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Get a single invoice publicly (no auth) — used for client-facing view
 * @route   GET /api/invoices/public/:id
 * @access  Public
 */
export const getPublicInvoice = async (req: Request, res: Response) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('clientId', 'name email')
      .populate('businessId', 'name currency');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Send invoice via email to client
 * @route   POST /api/invoices/:id/send
 * @access  Private
 */
export const sendInvoice = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Recipient email is required' });
    }

    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: user.businessId })
      .populate<{ clientId: { name: string; email: string } | null }>('clientId', 'name email');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    const business = await Business.findById(user.businessId);

    const clientName = invoice.clientId
      ? (invoice.clientId as any).name
      : invoice.customClientName || 'Valued Client';

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const publicLink = `${frontendUrl}/#/invoice/${invoice._id}`;

    const sent = await sendInvoiceEmail({
      invoiceNumber: invoice.invoiceNumber,
      businessName: business?.name || 'OpsFlow Business',
      clientName,
      recipientEmail: email,
      total: invoice.total,
      currency: (business as any)?.currency || 'USD',
      dueDate: invoice.dueDate.toISOString(),
      lineItems: invoice.lineItems.map(li => ({
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

    // Save recipient email + mark as sent regardless of email delivery
    invoice.recipientEmail = email;
    if (invoice.status === 'draft') invoice.status = 'sent';
    await invoice.save();

    emitToBusiness(String(user.businessId), 'data_updated', { type: 'invoice', action: 'sent' });

    res.status(200).json({
      message: sent
        ? `Invoice emailed to ${email} successfully`
        : 'Email delivery failed — check your SMTP settings on the server. Invoice was still marked as sent.',
      emailSent: sent,
      publicLink,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Generate a WhatsApp wa.me link for an invoice
 * @route   POST /api/invoices/:id/whatsapp
 * @access  Private
 */
export const getWhatsAppLink = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone number is required' });

    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: user.businessId })
      .populate<{ clientId: { name: string } | null }>('clientId', 'name');
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const business = await Business.findById(user.businessId);
    const clientName = invoice.clientId
      ? (invoice.clientId as any).name
      : invoice.customClientName || 'there';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const publicLink = `${frontendUrl}/#/invoice/${invoice._id}`;
    const dueDate = new Date(invoice.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

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

    res.status(200).json({ waUrl, message, publicLink });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Initialize a Paystack payment for an invoice
 * @route   POST /api/invoices/:id/pay/init
 * @access  Public
 */
export const initPaystackPayment = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const invoice = await Invoice.findById(req.params.id).populate('businessId', 'currency');
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    if (invoice.status === 'paid') {
      return res.status(400).json({ message: 'Invoice is already paid' });
    }

    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackKey) {
      return res.status(503).json({ message: 'Payment not configured on this server' });
    }

    const amountKobo = Math.round(invoice.total * 100);

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amountKobo,
        reference: `INV-${invoice._id}-${Date.now()}`,
        metadata: {
          invoice_id: String(invoice._id),
          invoice_number: invoice.invoiceNumber,
        },
        callback_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/invoice/${invoice._id}?paid=true`,
      },
      { headers: { Authorization: `Bearer ${paystackKey}`, 'Content-Type': 'application/json' } },
    );

    res.status(200).json({
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error: any) {
    const msg = error?.response?.data?.message || (error as Error).message;
    res.status(500).json({ message: msg });
  }
};

/**
 * @desc    Paystack webhook — marks invoice as paid and records income transaction
 * @route   POST /api/webhooks/paystack
 * @access  Public (verified by signature)
 */
export const paystackWebhook = async (req: Request, res: Response) => {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) return res.sendStatus(200);

  const hash = crypto
    .createHmac('sha512', paystackKey)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.sendStatus(401);
  }

  const event = req.body;

  if (event.event === 'charge.success') {
    const invoiceId = event.data?.metadata?.invoice_id;
    if (!invoiceId) return res.sendStatus(200);

    const invoice = await Invoice.findById(invoiceId);
    if (invoice && invoice.status !== 'paid') {
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
        invoice.transactionId = tx._id as any;
      }

      await invoice.save();
      emitToBusiness(String(invoice.businessId), 'data_updated', { type: 'invoice', action: 'paid' });
    }
  }

  res.sendStatus(200);
};
