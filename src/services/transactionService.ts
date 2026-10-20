import mongoose from 'mongoose';
import Transaction, { type ITransaction } from '../models/Transaction.js';
import { createNotification } from '../services/notificationService.js';
import { enqueue } from './exportQueueService.js';
import { fire } from './webhookService.js';
import { emitToBusiness } from './socketService.js';
import { predictCategory, learnTransactionCategory } from './learningService.js';
import { inferTaxCategory, type NigerianTaxCategory } from './nigerianTax.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex } from '../utils/regex.js';
import { extractDocumentText } from '../utils/documentExtraction.js';
import { parseTransactionText } from '../utils/documentParsing.js';
import type { IUser } from '../models/User.js';

// ─────────────────────────────────────────────────────────────────────────────
// Scanning is deliberately hardcoded, not AI-driven: OCR (images) / text-layer
// extraction (PDFs) via documentExtraction.ts, then regex parsing via
// documentParsing.ts. This used to call Gemini Vision, but a hosted model
// getting deprecated out from under the app (gemini-2.0-flash was retired by
// Google) silently broke scanning for every user with no code change on our
// end. A local, hardcoded pipeline can't be deprecated by a third party —
// the tradeoff is it only recognizes patterns we've explicitly written
// (labeled fields like "Amount Paid:", "Total:", etc.), so a receipt with a
// very unusual layout may come back empty rather than best-effort guessed.
// ─────────────────────────────────────────────────────────────────────────────

export const scanTransactionImage = async (buffer: Buffer, mimetype: string, businessId: string) => {
  const text = await extractDocumentText(buffer, mimetype);
  const parsed = parseTransactionText(text);

  if (parsed.transactions.length === 0) {
    throw new AppError('No transactions could be found in this document. Please try a clearer image, or check that amounts are labeled (e.g. "Total:").', 422);
  }

  const enhancedTransactions = await Promise.all(
    parsed.transactions.map(async (item) => {
      const learned = await predictCategory(businessId, item.description);
      return { ...item, category: learned ?? item.category };
    }),
  );

  return {
    transactions: enhancedTransactions,
    vendorName: parsed.vendorName,
    documentDate: parsed.documentDate,
    text,
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
    date?: string;
    taxCategory?: NigerianTaxCategory;
    vatable?: boolean;
    vatAmount?: number;
  },
) => {
  const { clientId, projectId, amount, type, category, description, date, taxCategory, vatable, vatAmount } = params;
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
    date: date ? new Date(date) : new Date(),
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
  params: {
    clientId?: string;
    projectId?: string;
    page?: string;
    limit?: string;
    search?: string;
    category?: string;
    type?: string;
    startDate?: string;
    endDate?: string;
  },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (params.clientId) filter.clientId = params.clientId;
  if (params.projectId) filter.projectId = params.projectId;
  if (params.search) filter.description = { $regex: escapeRegex(String(params.search)), $options: 'i' };
  if (params.category) filter.category = params.category;
  if (params.type) filter.type = params.type;
  if (params.startDate || params.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (params.startDate) dateFilter.$gte = new Date(params.startDate);
    if (params.endDate) dateFilter.$lte = new Date(params.endDate);
    filter.date = dateFilter;
  }

  const pageNum = Math.max(1, parseInt(String(params.page || '1')));
  const pageSize = Math.min(500, Math.max(1, parseInt(String(params.limit || '50'))));
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
  if (updates.date) transaction.date = new Date(updates.date as unknown as string);
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
