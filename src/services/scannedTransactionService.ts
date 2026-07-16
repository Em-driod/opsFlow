import mongoose from 'mongoose';
import ScannedTransaction from '../models/ScannedTransaction.js';
import Transaction from '../models/Transaction.js';
import { createNotification } from './notificationService.js';
import { predictCategory } from './learningService.js';
import { loadRules, evaluateItemWithRules, recordRuleHit } from './autoCommitEngine.js';
import { emitToBusiness } from './socketService.js';
import { inferTaxCategory } from './nigerianTax.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

interface ScannedItemInput {
  amount: number;
  type: 'income' | 'expense' | 'unassigned';
  description: string;
  category?: string;
  confidence?: number;
}

export const createScannedTransactionForBusiness = async (
  user: IUser,
  params: { transactions?: ScannedItemInput[]; text: string; originalFileName?: string },
) => {
  const { transactions, text, originalFileName } = params;
  if (!text) throw new AppError('No raw text provided for scan.', 400);

  // 1. Duplicate Detection (Basic check on recordedBy + filename + rawText length within last 24h)
  const yesterday = new Date();
  yesterday.setHours(yesterday.getHours() - 24);
  const possibleDuplicate = await ScannedTransaction.findOne({
    businessId: user.businessId,
    originalFileName,
    createdAt: { $gte: yesterday },
    rawText: text,
  });

  if (possibleDuplicate) {
    throw new AppError('Duplicate detected. This document was recently scanned.', 409);
  }

  // 2. Auto-Categorization for parsed items
  const enhancedTransactions = await Promise.all(
    (transactions || []).map(async (item) => {
      if (!item.category || item.category === 'Uncategorized') {
        const predicted = await predictCategory(String(user.businessId), item.description);
        if (predicted) {
          return { ...item, category: predicted, confidence: 0.9 };
        }
      }
      return { ...item, confidence: typeof item.confidence === 'number' ? item.confidence : 0.7 };
    }),
  );

  // 3. Auto-Commit Rules: try to clear items off the review queue when rules match
  const rules = await loadRules(String(user.businessId));
  let autoCommittedCount = 0;
  const finalParsedDetails: Array<ScannedItemInput & { status: string; autoRuleId?: unknown }> = [];
  for (const item of enhancedTransactions) {
    const decision = evaluateItemWithRules(item, rules);
    if (decision.autoCommit && decision.rule) {
      const finalCategory = decision.finalCategory || item.category || 'Uncategorized';
      const finalType: 'income' | 'expense' = item.type === 'unassigned' ? 'expense' : item.type;
      const finalTaxCategory = inferTaxCategory(finalCategory || item.description, finalType) || undefined;
      await Transaction.create({
        businessId: user.businessId,
        amount: item.amount,
        type: finalType,
        category: finalCategory,
        description: item.description,
        recordedBy: user._id,
        source: 'ocr_scan',
        ...(finalTaxCategory ? { taxCategory: finalTaxCategory } : {}),
      });
      await recordRuleHit(String(decision.rule._id));
      autoCommittedCount++;
      finalParsedDetails.push({ ...item, category: finalCategory, status: 'auto_committed', autoRuleId: decision.rule._id });
    } else {
      finalParsedDetails.push({ ...item, status: 'pending' });
    }
  }

  const allAuto = finalParsedDetails.length > 0 && finalParsedDetails.every((it) => it.status === 'auto_committed');

  const scannedTx = await ScannedTransaction.create({
    businessId: user.businessId,
    rawText: text,
    originalFileName,
    recordedBy: user._id,
    status: allAuto ? 'processed' : 'pending',
    parsedDetails: finalParsedDetails,
  });

  if (autoCommittedCount > 0) {
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'auto_committed' });
  }

  const reviewCount = finalParsedDetails.length - autoCommittedCount;
  const noteParts: string[] = [];
  if (autoCommittedCount > 0) noteParts.push(`${autoCommittedCount} auto-committed`);
  if (reviewCount > 0) noteParts.push(`${reviewCount} awaiting review`);
  const note = noteParts.length > 0 ? noteParts.join(', ') : 'no items detected';

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `Scanned document processed: ${note}.`,
    link: autoCommittedCount > 0 && reviewCount === 0 ? `/transactions` : `/scanned-transactions`,
  });

  return scannedTx;
};

export const getScannedTransactionsForBusiness = (businessId: mongoose.Types.ObjectId) =>
  ScannedTransaction.find({ businessId, status: 'pending' }).sort({ createdAt: -1 });

export const commitScannedTransactionForBusiness = async (
  user: IUser,
  scannedTxId: string,
  params: { amount: number; type: string; category: string; description: string; clientId?: string; itemIndex: number },
) => {
  const { amount, type, category, description, clientId, itemIndex } = params;

  const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });
  if (!scannedTx) throw new AppError('Scanned transaction not found.', 404);

  const selectedItem = scannedTx.parsedDetails[itemIndex];
  if (!selectedItem) throw new AppError('Item not found in scanned data.', 404);
  if (selectedItem.status === 'committed') throw new AppError('This item has already been committed.', 400);

  const transaction = await Transaction.create({
    businessId: user.businessId,
    clientId: clientId || undefined,
    amount,
    type,
    category,
    description,
    recordedBy: user._id,
  });

  selectedItem.status = 'committed';

  const allItemsCommitted = scannedTx.parsedDetails.every((item) => item.status === 'committed');
  if (allItemsCommitted) scannedTx.status = 'processed';

  await scannedTx.save();

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `A scanned document item has been approved and a new ${type} transaction of ${amount} was created.`,
    link: `/transactions`,
  });

  return transaction;
};

export const updateParsedScanItemForBusiness = async (
  user: IUser,
  scannedTxId: string,
  itemIndex: number,
  updatedItemData: Record<string, unknown>,
) => {
  const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });
  if (!scannedTx) throw new AppError('Scanned transaction not found.', 404);

  if (itemIndex < 0 || itemIndex >= scannedTx.parsedDetails.length) {
    throw new AppError('Parsed item not found at index.', 404);
  }

  const existingItem = scannedTx.parsedDetails[itemIndex];
  if (existingItem) {
    scannedTx.parsedDetails[itemIndex] = { ...existingItem, ...updatedItemData, status: 'edited' };
  }

  const updatedScannedTx = await scannedTx.save();
  return updatedScannedTx.parsedDetails[itemIndex];
};

export const commitAllScannedItemsForBusiness = async (user: IUser, scannedTxId: string) => {
  const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });
  if (!scannedTx) throw new AppError('Scanned transaction not found.', 404);

  const committedTransactions = [];
  let committedCount = 0;

  for (let i = 0; i < scannedTx.parsedDetails.length; i++) {
    const item = scannedTx.parsedDetails[i];
    if (item && (item.status === 'pending' || item.status === 'edited')) {
      const transaction = await Transaction.create({
        businessId: user.businessId,
        amount: item.amount,
        type: item.type === 'unassigned' ? 'expense' : item.type,
        category: item.category,
        description: item.description,
        recordedBy: user._id,
      });
      committedTransactions.push(transaction);
      item.status = 'committed';
      committedCount++;
    }
  }

  const allItemsCommitted = scannedTx.parsedDetails.every((item) => item.status === 'committed');
  if (allItemsCommitted) scannedTx.status = 'processed';

  await scannedTx.save();

  await createNotification({
    businessId: user.businessId,
    userId: user._id as mongoose.Types.ObjectId,
    message: `${committedCount} items from a scanned document were approved and added as transactions.`,
    link: `/transactions`,
  });

  return { committedCount, committedTransactions };
};

export const deleteScannedTransactionForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const scannedTx = await ScannedTransaction.findOne({ _id: id, businessId });
  if (!scannedTx) throw new AppError('Scanned transaction not found', 404);
  await scannedTx.deleteOne();
};
