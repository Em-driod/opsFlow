import mongoose from 'mongoose';
import crypto from 'crypto';
import Receipt from '../models/Receipt.js';
import type { IReceiptItem } from '../models/Receipt.js';
import Business from '../models/Business.js';
import { sendIssuedReceiptEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';

export const getReceiptsForBusiness = (businessId: mongoose.Types.ObjectId) =>
  Receipt.find({ businessId }).sort({ createdAt: -1 });

// Opaque, non-sequential receipt number: date-stamped + random suffix.
// Doesn't leak how many receipts a business has issued, unlike an incrementing counter.
const generateReceiptNumber = () => {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars
  return `RCP-${datePart}-${randomPart}`;
};

export const createReceiptForBusiness = async (businessId: mongoose.Types.ObjectId, body: Record<string, unknown>) => {
  try {
    const items = Array.isArray(body.items) ? (body.items as IReceiptItem[]) : [];
    const transactionIds = Array.isArray(body.transactionIds) ? (body.transactionIds as string[]) : undefined;
    const amount = items.length > 0 ? items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0) : Number(body.amount);

    const publicToken = crypto.randomBytes(20).toString('hex');

    // Collision odds are astronomically low, but retry once just in case.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await Receipt.create({
          ...body,
          items,
          transactionIds,
          transactionId: transactionIds?.[0] ?? body.transactionId,
          amount,
          businessId,
          receiptNumber: generateReceiptNumber(),
          publicToken,
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000 && attempt < 2) continue;
        throw e;
      }
    }
    throw new AppError('Could not generate a unique receipt number, please try again', 500);
  } catch (err) {
    if (err instanceof AppError) throw err;
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
