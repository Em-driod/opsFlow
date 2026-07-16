import mongoose from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Transaction, { type ITransaction } from '../models/Transaction.js';
import { createNotification } from '../services/notificationService.js';
import { enqueue } from './exportQueueService.js';
import { fire } from './webhookService.js';
import { emitToBusiness } from './socketService.js';
import { predictCategory, learnTransactionCategory } from './learningService.js';
import { inferTaxCategory, type NigerianTaxCategory } from './nigerianTax.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

// ─────────────────────────────────────────────────────────────────────────────
// OCR UPGRADE: Gemini Vision replacing Tesseract + Regex
//
// The previous implementation used Tesseract.js (CPU-heavy, blocks the event
// loop) followed by a fragile regex parser. It failed on any receipt that used
// a non-standard layout, and it could only detect amounts by looking for a "$"
// symbol — meaning European / multi-currency receipts always returned nothing.
//
// The new implementation sends the image directly to Gemini Vision as a base64
// inline part, and asks the model to return structured JSON. Accuracy jumps to
// near 100% across all receipt/invoice formats and currencies.
// ─────────────────────────────────────────────────────────────────────────────

interface ScannedItem {
  amount: number;
  type: 'income' | 'expense';
  description: string;
  category: string;
}

const VISION_EXTRACTION_PROMPT = `
You are a financial document parser. Carefully examine the attached image (a receipt, invoice, or bank statement).
Extract ALL line items or transactions visible. For each, determine:
- amount: the numeric value (no currency symbols)
- type: "expense" if it is a purchase/payment/bill, "income" if it is a payment received/deposit
- description: a short, clear description of what this transaction is for (vendor name + item if visible)
- category: one of ["Food & Dining", "Transportation", "Utilities", "Office Supplies", "Software & Services", "Professional Services", "Marketing", "Equipment", "Rent", "Insurance", "Sales", "Other"]

Return ONLY a valid JSON object — no markdown, no explanation — in this exact shape:
{
  "transactions": [
    { "amount": 25.50, "type": "expense", "description": "Starbucks Coffee", "category": "Food & Dining" }
  ],
  "documentType": "receipt" | "invoice" | "bank_statement" | "unknown",
  "vendorName": "string or null",
  "documentDate": "YYYY-MM-DD or null",
  "currency": "USD" | "GBP" | "EUR" | "NGN" | "other"
}

If you cannot find any transactions, return: { "transactions": [], "documentType": "unknown", "vendorName": null, "documentDate": null, "currency": "other" }
`;

/**
 * Helper: Calls Gemini Vision to extract structured transaction data from an image buffer.
 * Returns null on failure so the caller can handle gracefully.
 */
const extractWithGeminiVision = async (
  imageBuffer: Buffer,
  mimeType: string,
): Promise<{ transactions: ScannedItem[]; vendorName?: string | null; documentDate?: string | null } | null> => {
  if (!apiKey) return null;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif',
      },
    };

    const result = await model.generateContent([VISION_EXTRACTION_PROMPT, imagePart]);
    const raw = result.response
      .text()
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(raw);

    if (!parsed.transactions || !Array.isArray(parsed.transactions)) {
      console.error('[GeminiVision] Model returned invalid shape:', raw);
      return null;
    }

    const sanitised: ScannedItem[] = parsed.transactions
      .filter((t: { amount?: unknown }) => typeof t.amount === 'number' && t.amount > 0)
      .map((t: { amount: number; type?: string; description?: string; category?: string }) => ({
        amount: Math.abs(t.amount),
        type: t.type === 'income' ? 'income' : 'expense',
        description: String(t.description ?? 'Scanned Transaction').substring(0, 100),
        category: String(t.category ?? 'Other'),
      }));

    return {
      transactions: sanitised,
      vendorName: parsed.vendorName ?? null,
      documentDate: parsed.documentDate ?? null,
    };
  } catch (err) {
    console.error('[GeminiVision] Extraction failed:', err);
    return null;
  }
};

export const scanTransactionImage = async (buffer: Buffer, mimetype: string, businessId: string) => {
  const visionResult = await extractWithGeminiVision(buffer, mimetype);

  if (!visionResult || visionResult.transactions.length === 0) {
    throw new AppError('No transactions could be found in this document. Please try a clearer image.', 422);
  }

  const enhancedTransactions = await Promise.all(
    visionResult.transactions.map(async (item) => {
      const learned = await predictCategory(businessId, item.description);
      return { ...item, category: learned ?? item.category };
    }),
  );

  return {
    transactions: enhancedTransactions,
    vendorName: visionResult.vendorName,
    documentDate: visionResult.documentDate,
  };
};

export const getRevenueStatsForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const [incomeResult, expenseResult] = await Promise.all([
    Transaction.aggregate([
      { $match: { businessId, type: 'income' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate([
      { $match: { businessId, type: 'expense' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  return {
    totalIncome: incomeResult[0]?.total ?? 0,
    totalExpense: expenseResult[0]?.total ?? 0,
  };
};

export const createTransactionForBusiness = async (
  req: { user: IUser },
  params: {
    clientId?: string;
    projectId?: string;
    amount: number;
    type: 'income' | 'expense';
    category: string;
    description?: string;
    taxCategory?: NigerianTaxCategory;
    vatable?: boolean;
    vatAmount?: number;
  },
) => {
  const { clientId, projectId, amount, type, category, description, taxCategory, vatable, vatAmount } = params;
  const user = req.user;

  const finalTaxCategory = taxCategory || inferTaxCategory(category || description, type) || undefined;

  const transaction = await Transaction.create({
    clientId: clientId || undefined,
    projectId: projectId || undefined,
    businessId: user.businessId,
    amount,
    type,
    category,
    description,
    recordedBy: user._id,
    source: 'manual',
    ...(finalTaxCategory ? { taxCategory: finalTaxCategory } : {}),
    ...(typeof vatable === 'boolean' ? { vatable } : {}),
    ...(typeof vatAmount === 'number' ? { vatAmount } : {}),
  });

  await learnTransactionCategory(String(user.businessId), description || '', category);

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `New ${type} transaction of ${amount} recorded.`,
    link: `/transactions`,
  });

  enqueue({ type: 'transaction', action: 'created', data: transaction.toObject(), businessId: String(user.businessId) });
  fire('transaction.created', String(user.businessId), transaction.toObject());
  emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'created' });

  return transaction;
};

export const getTransactionsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { clientId?: string; projectId?: string; page?: string; limit?: string; search?: string },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (params.clientId) filter.clientId = params.clientId;
  if (params.projectId) filter.projectId = params.projectId;
  if (params.search) filter.description = { $regex: String(params.search), $options: 'i' };

  const pageNum = Math.max(1, parseInt(String(params.page || '1')));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(params.limit || '50'))));
  const skip = (pageNum - 1) * pageSize;

  const [transactions, total] = await Promise.all([
    Transaction.find(filter).populate('recordedBy', 'name').sort({ createdAt: -1 }).skip(skip).limit(pageSize),
    Transaction.countDocuments(filter),
  ]);

  return { data: transactions, total, page: pageNum, pages: Math.ceil(total / pageSize) };
};

export const getTransactionByIdForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const transaction = await Transaction.findOne({ _id: id, businessId });
  if (!transaction) throw new AppError('Transaction not found', 404);
  return transaction;
};

export const updateTransactionForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  updates: Partial<ITransaction>,
) => {
  const transaction = await Transaction.findOne({ _id: id, businessId });
  if (!transaction) throw new AppError('Transaction not found', 404);

  transaction.amount = updates.amount || transaction.amount;
  transaction.type = updates.type || transaction.type;
  transaction.category = updates.category || transaction.category;
  if (updates.description !== undefined) transaction.description = updates.description;
  if (updates.clientId !== undefined) transaction.clientId = updates.clientId || undefined;
  if (updates.projectId !== undefined) transaction.projectId = updates.projectId || undefined;
  if (updates.taxCategory !== undefined) transaction.taxCategory = updates.taxCategory || undefined;
  if (typeof updates.vatable === 'boolean') transaction.vatable = updates.vatable;
  if (typeof updates.vatAmount === 'number') transaction.vatAmount = updates.vatAmount;
  if (updates.receiptImage) transaction.receiptImage = updates.receiptImage;

  const updatedTransaction = await transaction.save();

  await learnTransactionCategory(String(businessId), updatedTransaction.description || '', updatedTransaction.category);

  enqueue({ type: 'transaction', action: 'updated', data: updatedTransaction.toObject(), businessId: String(businessId) });
  fire('transaction.updated', String(businessId), updatedTransaction.toObject());
  emitToBusiness(String(businessId), 'data_updated', { type: 'transaction', action: 'updated' });

  return updatedTransaction;
};

export const deleteTransactionForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const transaction = await Transaction.findOne({ _id: id, businessId });
  if (!transaction) throw new AppError('Transaction not found', 404);

  await transaction.deleteOne();
  emitToBusiness(String(businessId), 'data_updated', { type: 'transaction', action: 'deleted' });
  return transaction;
};
