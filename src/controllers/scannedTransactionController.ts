import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as scannedTransactionService from '../services/scannedTransactionService.js';

// @desc    Create a scanned transaction from OCR data
// @route   POST /api/scanned-transactions
// @access  Private
export const createScannedTransaction = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const scannedTx = await scannedTransactionService.createScannedTransactionForBusiness(req.user, req.body);
  res.status(201).json(scannedTx);
});

// @desc    Get all pending scanned transactions for a business
// @route   GET /api/scanned-transactions
// @access  Private
export const getScannedTransactions = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const scans = await scannedTransactionService.getScannedTransactionsForBusiness(req.user.businessId);
  res.json(scans);
});

// @desc    Commit a scanned transaction to a real transaction
// @route   POST /api/scanned-transactions/:id/commit
// @access  Private
export const commitScannedTransaction = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const transaction = await scannedTransactionService.commitScannedTransactionForBusiness(
    req.user,
    req.params.id as string,
    req.body,
  );
  res.status(201).json({ message: 'Transaction committed successfully.', transaction });
});

// @desc    Update a specific parsed item within a scanned transaction
// @route   PUT /api/scanned-transactions/:id/parsed-items/:itemIndex
// @access  Private
export const updateParsedScanItem = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const itemIndex = parseInt(req.params.itemIndex as string);
  const updated = await scannedTransactionService.updateParsedScanItemForBusiness(
    req.user,
    req.params.id as string,
    itemIndex,
    req.body,
  );
  res.json(updated);
});

// @desc    Commit all pending/edited parsed items within a scanned transaction
// @route   POST /api/scanned-transactions/:id/commit-all
// @access  Private
export const commitAllScannedItems = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { committedCount, committedTransactions } = await scannedTransactionService.commitAllScannedItemsForBusiness(
    req.user,
    req.params.id as string,
  );
  res.status(201).json({ message: `Successfully committed ${committedCount} transactions.`, transactions: committedTransactions });
});

// @desc    Delete a scanned transaction
// @route   DELETE /api/scanned-transactions/:id
// @access  Private
export const deleteScannedTransaction = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await scannedTransactionService.deleteScannedTransactionForBusiness(req.params.id as string, req.user.businessId);
  res.json({ message: 'Scanned transaction removed' });
});
