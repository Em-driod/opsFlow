import type { Request, Response } from 'express';
import ScannedTransaction from '../models/ScannedTransaction.js';
import Transaction from '../models/Transaction.js';
import { createNotification } from './notificationController.js';

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

    const scannedTx = await ScannedTransaction.create({
      businessId: user.businessId,
      rawText: text,
      originalFileName,
      recordedBy: user._id,
      status: 'pending',
      parsedDetails: transactions || [], // Save the array of parsed items
    });
    
    await createNotification({
        businessId: user.businessId,
        userId: user._id,
        message: `Successfully saved a new scanned document for review.`,
        link: `/scanned-transactions`,
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
        const scannedTxId = req.params.id;
        const { amount, type, category, description, clientId, itemIndex } = req.body; // Expect itemIndex

        const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });

        if (!scannedTx) {
            return res.status(404).json({ message: 'Scanned transaction not found.' });
        }

        // Check if the specific parsed item has already been committed
        if (scannedTx.parsedDetails[itemIndex]?.status === 'committed') {
            return res.status(400).json({ message: 'This item has already been committed.' });
        }

        const transaction = await Transaction.create({
            businessId: user.businessId,
            clientId: clientId || undefined,
            amount,
            type,
            category,
            description,
            recordedBy: user._id,
        });

        // Update the status of the specific parsed item
        if (scannedTx.parsedDetails[itemIndex]) {
            scannedTx.parsedDetails[itemIndex].status = 'committed';
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
    const scannedTxId = req.params.id;
    const itemIndex = parseInt(req.params.itemIndex);
    const updatedItemData = req.body;

    const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });

    if (!scannedTx) {
      return res.status(404).json({ message: 'Scanned transaction not found.' });
    }

    if (itemIndex < 0 || itemIndex >= scannedTx.parsedDetails.length) {
      return res.status(404).json({ message: 'Parsed item not found at index.' });
    }

    // Update the specific item
    scannedTx.parsedDetails[itemIndex] = {
      ...scannedTx.parsedDetails[itemIndex],
      ...updatedItemData,
      status: 'edited', // Mark as edited
    };

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
    const scannedTxId = req.params.id;

    const scannedTx = await ScannedTransaction.findOne({ _id: scannedTxId, businessId: user.businessId });

    if (!scannedTx) {
      return res.status(404).json({ message: 'Scanned transaction not found.' });
    }

    const committedTransactions = [];
    let committedCount = 0;

    for (let i = 0; i < scannedTx.parsedDetails.length; i++) {
      const item = scannedTx.parsedDetails[i];

      // Only commit if the item is pending or has been edited
      if (item.status === 'pending' || item.status === 'edited') {
        const transaction = await Transaction.create({
          businessId: user.businessId,
          amount: item.amount,
          type: item.type === 'unassigned' ? 'expense' : item.type, // Default to expense if unassigned
          category: item.category,
          description: item.description,
          recordedBy: user._id,
        });
        committedTransactions.push(transaction);
        scannedTx.parsedDetails[i].status = 'committed'; // Mark as committed
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
      _id: req.params.id,
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
