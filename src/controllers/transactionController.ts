import type { Request, Response } from 'express';
import { logActivity } from '../utils/activityLogger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as transactionService from '../services/transactionService.js';

// @desc    Scan a transaction receipt/invoice using Gemini Vision
// @route   POST /api/transactions/scan
// @access  Private
export const scanTransaction = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  if (!req.file) throw new AppError('No file uploaded.', 400);

  const result = await transactionService.scanTransactionImage(
    req.file.buffer,
    req.file.mimetype,
    String(req.user.businessId),
  );
  res.status(200).json(result);
});

// @desc    Get total revenue stats
// @route   GET /api/transactions/revenue-stats
// @access  Private
export const getRevenueStats = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await transactionService.getRevenueStatsForBusiness(req.user.businessId);
  res.status(200).json(result);
});

// @desc    Create a new transaction
// @route   POST /api/transactions
// @access  Private
export const createTransaction = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const transaction = await transactionService.createTransactionForBusiness({ user: req.user }, req.body);

  logActivity({
    req,
    action: 'CREATE',
    resource: 'TRANSACTION',
    resourceId: String(transaction._id),
    details: { amount: req.body.amount, type: req.body.type, description: req.body.description, category: req.body.category },
  }).catch(() => {});

  res.status(201).json(transaction);
});

// @desc    Get all transactions for a business
// @route   GET /api/transactions
// @access  Private
export const getTransactions = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { clientId, projectId, page, limit, search } = req.query;
  const result = await transactionService.getTransactionsForBusiness(req.user.businessId, {
    clientId: clientId as string,
    projectId: projectId as string,
    page: page as string,
    limit: limit as string,
    search: search as string,
  });
  res.json(result);
});

// @desc    Get transaction by ID
// @route   GET /api/transactions/:id
// @access  Private
export const getTransactionById = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const transaction = await transactionService.getTransactionByIdForBusiness(req.params.id!, req.user.businessId);
  res.json(transaction);
});

// @desc    Update transaction
// @route   PUT /api/transactions/:id
// @access  Private
export const updateTransaction = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const updatedTransaction = await transactionService.updateTransactionForBusiness(
    req.params.id!,
    req.user.businessId,
    req.body,
  );
  res.json(updatedTransaction);
});

// @desc    Delete transaction
// @route   DELETE /api/transactions/:id
// @access  Private
export const deleteTransaction = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const transaction = await transactionService.deleteTransactionForBusiness(req.params.id!, req.user.businessId);

  logActivity({
    req,
    action: 'DELETE',
    resource: 'TRANSACTION',
    resourceId: String(transaction._id),
    details: { amount: transaction.amount, description: transaction.description },
  }).catch(() => {});

  res.json({ message: 'Transaction removed' });
});
