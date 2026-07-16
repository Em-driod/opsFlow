import mongoose from 'mongoose';
import crypto from 'crypto';
import Receipt from '../models/Receipt.js';
import Business from '../models/Business.js';
import Counter from '../models/Counter.js';
import { sendIssuedReceiptEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';

export const getReceiptsForBusiness = (businessId: mongoose.Types.ObjectId) =>
  Receipt.find({ businessId }).sort({ createdAt: -1 });

export const createReceiptForBusiness = async (businessId: mongoose.Types.ObjectId, body: Record<string, unknown>) => {
  try {
    const COUNTER_ID = `receipts_${businessId}`;
    const exists = await Counter.exists({ _id: COUNTER_ID });
    if (!exists) {
      const existing = await Receipt.countDocuments({ businessId });
      try {
        await Counter.create({ _id: COUNTER_ID, seq: existing });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    }
    const counter = await Counter.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { seq: 1 } }, { new: true });
    const receiptNumber = `RCP-${counter!.seq.toString().padStart(4, '0')}`;
    const publicToken = crypto.randomBytes(20).toString('hex');

    return await Receipt.create({ ...body, businessId, receiptNumber, publicToken });
  } catch (err) {
    throw new AppError((err as Error).message, 400);
  }
};

export const deleteReceiptForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const receipt = await Receipt.findOneAndDelete({ _id: id, businessId });
  if (!receipt) throw new AppError('Receipt not found', 404);
};

export const sendReceiptByEmailForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  emailOverride?: string,
) => {
  const receipt = await Receipt.findOne({ _id: id, businessId });
  if (!receipt) throw new AppError('Receipt not found', 404);

  const email = emailOverride || receipt.payerEmail;
  if (!email) throw new AppError('No email address provided', 400);

  const business = await Business.findById(businessId).select('name currency').lean();
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  const publicLink = `${frontendUrl}/receipt/${receipt.publicToken}`;

  const sent = await sendIssuedReceiptEmail({
    recipientEmail: email,
    payerName: receipt.payerName,
    businessName: business?.name || 'OpsFlow Business',
    receiptNumber: receipt.receiptNumber,
    amount: receipt.amount,
    currency: receipt.currency,
    description: receipt.description,
    date: receipt.date.toISOString(),
    publicLink,
  }).catch(() => false);

  return { emailSent: sent, publicLink };
};

export const getPublicReceiptByToken = async (token: string) => {
  const receipt = await Receipt.findOne({ publicToken: token }).lean();
  if (!receipt) throw new AppError('Receipt not found', 404);

  const business = await Business.findById(receipt.businessId).select('name email phone address logo').lean();

  return { receipt, business };
};
