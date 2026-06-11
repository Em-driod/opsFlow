import type { Request, Response } from 'express';
import crypto from 'crypto';
import Receipt from '../models/Receipt.js';
import Business from '../models/Business.js';
import Counter from '../models/Counter.js';
import { sendIssuedReceiptEmail } from '../services/emailService.js';

// GET /api/receipts
export const getReceipts = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const receipts = await Receipt.find({ businessId }).sort({ createdAt: -1 });
    res.json(receipts);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/receipts
export const createReceipt = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;

    // Generate receipt number
    const COUNTER_ID = `receipts_${businessId}`;
    const exists = await Counter.exists({ _id: COUNTER_ID });
    if (!exists) {
      const existing = await Receipt.countDocuments({ businessId });
      try { await Counter.create({ _id: COUNTER_ID, seq: existing }); } catch (e: any) { if (e.code !== 11000) throw e; }
    }
    const counter = await Counter.findOneAndUpdate(
      { _id: COUNTER_ID },
      { $inc: { seq: 1 } },
      { new: true },
    );
    const receiptNumber = `RCP-${counter!.seq.toString().padStart(4, '0')}`;
    const publicToken = crypto.randomBytes(20).toString('hex');

    const receipt = await Receipt.create({
      ...req.body,
      businessId,
      receiptNumber,
      publicToken,
    });

    res.status(201).json(receipt);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// DELETE /api/receipts/:id
export const deleteReceipt = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const receipt = await Receipt.findOneAndDelete({ _id: req.params.id, businessId });
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });
    res.json({ message: 'Deleted' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/receipts/:id/send-email
export const sendReceiptByEmail = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const receipt = await Receipt.findOne({ _id: req.params.id, businessId });
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    const email = req.body.email || receipt.payerEmail;
    if (!email) return res.status(400).json({ message: 'No email address provided' });

    const business = await Business.findById(businessId).select('name currency').lean();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const publicLink = `${frontendUrl}/#/receipt/${receipt.publicToken}`;

    const sent = await sendIssuedReceiptEmail({
      recipientEmail: email,
      payerName: receipt.payerName,
      businessName: (business as any)?.name || 'OpsFlow Business',
      receiptNumber: receipt.receiptNumber,
      amount: receipt.amount,
      currency: receipt.currency,
      description: receipt.description,
      date: receipt.date.toISOString(),
      publicLink,
    }).catch(() => false);

    res.json({ emailSent: sent, publicLink });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/receipts/public/:token  — no auth
export const getPublicReceipt = async (req: Request, res: Response) => {
  try {
    const receipt = await Receipt.findOne({ publicToken: req.params.token }).lean();
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    const business = await Business.findById(receipt.businessId)
      .select('name email phone address logo')
      .lean();

    res.json({ receipt, business });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};
