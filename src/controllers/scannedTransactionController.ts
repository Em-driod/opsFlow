import type { Request, Response } from 'express';
import ScannedTransaction from '../models/ScannedTransaction.js';
import Transaction from '../models/Transaction.js';
import { createNotification } from './notificationController.js';
import { predictCategory, learnTransactionCategory } from '../services/learningService.js';
import { loadRules, evaluateItemWithRules, recordRuleHit } from '../services/autoCommitEngine.js';
import { emitToBusiness } from '../services/socketService.js';
import { inferTaxCategory } from '../services/nigerianTax.js';

// @desc    Create a scanned transaction from OCR data
// @route   POST /api/scanned-transactions
// @access  Private
export const createScannedTransaction = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { transactions, text, originalFileName } = req.body;

    if (!text) {
      return res.status(400).json({ message: 'No raw text provided for scan.' });
    }

    // 1. Duplicate Detection (Basic check on recordedBy + filename + rawText length within last 24h)
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    const possibleDuplicate = await ScannedTransaction.findOne({
      businessId: user.businessId,
      originalFileName,
      createdAt: { $gte: yesterday },
      rawText: text // Check if text is identical
    });

    if (possibleDuplicate) {
      return res.status(409).json({ 
        message: 'Duplicate detected. This document was recently scanned.',
        duplicateId: possibleDuplicate._id 
      });
    }

    // 2. Auto-Categorization for parsed items
    const enhancedTransactions = await Promise.all((transactions || []).map(async (item: any) => {
      if (!item.category || item.category === 'Uncategorized') {
        const predicted = await predictCategory(user.businessId, item.description);
        if (predicted) {
          return { ...item, category: predicted, confidence: 0.9 }; // Mark as high confidence if predicted
        }
      }
      return { ...item, confidence: typeof item.confidence === 'number' ? item.confidence : 0.7 };
    }));

    // 3. Auto-Commit Rules: try to clear items off the review queue when rules match
    const rules = await loadRules(String(user.businessId));
    let autoCommittedCount = 0;
    const finalParsedDetails: any[] = [];
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
        finalParsedDetails.push({
          ...item,
          category: finalCategory,
          status: 'auto_committed',
          autoRuleId: decision.rule._id,
        });
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
      userId: user._id,
      message: `Scanned document processed: ${note}.`,
      link: autoCommittedCount > 0 && reviewCount === 0 ? `/transactions` : `/scanned-transactions`,
    });

    res.status(201).json(scannedTx);
  } catch (error) {
    res.status(500).json({ message: 'Error saving scanned transaction', error: (error as Error).message });
    console.error('Error creating scanned transaction:', error);
  }
};

// @desc    Get all pending scanned transactions for a business
// @route   GET /api/scanned-transactions
// @access  Private
export const getScannedTransactions = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const scans = await ScannedTransaction.find({
      businessId: user.businessId,
      status: 'pending',
    }).sort({ createdAt: -1 });
    res.json(scans);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error fetching scanned transactions:', error);
  }
};

// @desc    Commit a scanned transaction to a real transaction
// @route   POST /api/scanned-transactions/:id/commit
// @access  Private
export const commitScannedTransaction = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const scannedTxId = req.params.id as string;
    const { amount, type, category, description, clientId, itemIndex } = req.body; // Expect itemIndex

    const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });

    if (!scannedTx) {
      return res.status(404).json({ message: 'Scanned transaction not found.' });
    }

    // Check if the specific parsed item has already been committed
    const selectedItem = scannedTx.parsedDetails[itemIndex];
    if (!selectedItem) {
      return res.status(404).json({ message: 'Item not found in scanned data.' });
    }

    if (selectedItem.status === 'committed') {
      return res.status(400).json({ message: 'This item has already been committed.' });
    }

    const transaction = await Transaction.create({
      businessId: user.businessId,
      clientId: clientId || undefined,
      amount: amount,
      type: type,
      category: category,
      description: description,
      recordedBy: user._id,
    });

    // Update the status of the specific parsed item
    selectedItem.status = 'committed';

    // Check if all parsed items are committed, if so, mark the entire scannedTx as processed
    const allItemsCommitted = scannedTx.parsedDetails.every(item => item.status === 'committed');
    if (allItemsCommitted) {
      scannedTx.status = 'processed';
    }

    await scannedTx.save();

    await createNotification({
      businessId: user.businessId,
      userId: user._id,
      message: `A scanned document item has been approved and a new ${type} transaction of ${amount} was created.`,
      link: `/transactions`,
    });

    res.status(201).json({ message: 'Transaction committed successfully.', transaction });

  } catch (error) {
    res.status(500).json({ message: 'Error committing transaction', error: (error as Error).message });
    console.error('Error committing scanned transaction:', error);
  }
};

// @desc    Update a specific parsed item within a scanned transaction
// @route   PUT /api/scanned-transactions/:id/parsed-items/:itemIndex
// @access  Private
export const updateParsedScanItem = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const scannedTxId = req.params.id as string;
    const itemIndex = parseInt(req.params.itemIndex as string);
    const updatedItemData = req.body;

    const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });

    if (!scannedTx) {
      return res.status(404).json({ message: 'Scanned transaction not found.' });
    }

    if (itemIndex < 0 || itemIndex >= scannedTx.parsedDetails.length) {
      return res.status(404).json({ message: 'Parsed item not found at index.' });
    }

    // Update the specific item
    const existingItem = scannedTx.parsedDetails[itemIndex];
    if (existingItem) {
      scannedTx.parsedDetails[itemIndex] = {
        ...existingItem,
        ...updatedItemData,
        status: 'edited', // Mark as edited
      };
    }

    const updatedScannedTx = await scannedTx.save();
    res.json(updatedScannedTx.parsedDetails[itemIndex]);

  } catch (error) {
    res.status(500).json({ message: 'Error updating parsed item', error: (error as Error).message });
    console.error('Error updating parsed scan item:', error);
  }
};

// @desc    Commit all pending/edited parsed items within a scanned transaction
// @route   POST /api/scanned-transactions/:id/commit-all
// @access  Private
export const commitAllScannedItems = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const scannedTxId = req.params.id as string;

    const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });

    if (!scannedTx) {
      return res.status(404).json({ message: 'Scanned transaction not found.' });
    }

    const committedTransactions = [];
    let committedCount = 0;

    for (let i = 0; i < scannedTx.parsedDetails.length; i++) {
      const item = scannedTx.parsedDetails[i];

      // Only commit if the item exists and is pending or has been edited
      if (item && (item.status === 'pending' || item.status === 'edited')) {
        const transaction = await Transaction.create({
          businessId: user.businessId,
          amount: item.amount,
          type: item.type === 'unassigned' ? 'expense' : item.type, // Default to expense if unassigned
          category: item.category,
          description: item.description,
          recordedBy: user._id,
        });
        committedTransactions.push(transaction);
        item.status = 'committed'; // Mark as committed
        committedCount++;
      }
    }

    // Check if all parsed items are committed, if so, mark the entire scannedTx as processed
    const allItemsCommitted = scannedTx.parsedDetails.every(item => item.status === 'committed');
    if (allItemsCommitted) {
      scannedTx.status = 'processed';
    }

    await scannedTx.save();

    await createNotification({
      businessId: user.businessId,
      userId: user._id,
      message: `${committedCount} items from a scanned document were approved and added as transactions.`,
      link: `/transactions`,
    });

    res.status(201).json({ message: `Successfully committed ${committedCount} transactions.`, transactions: committedTransactions });

  } catch (error) {
    res.status(500).json({ message: 'Error committing all scanned items', error: (error as Error).message });
    console.error('Error committing all scanned items:', error);
  }
};

// @desc    Delete a scanned transaction
// @route   DELETE /api/scanned-transactions/:id
// @access  Private
export const deleteScannedTransaction = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const scannedTx = await ScannedTransaction.findOne({
      _id: req.params.id as string,
      businessId: user.businessId,
    });

    if (scannedTx) {
      await scannedTx.deleteOne();
      res.json({ message: 'Scanned transaction removed' });
    } else {
      res.status(404).json({ message: 'Scanned transaction not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error deleting scanned transaction:', error);
  }
};
