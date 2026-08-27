import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import { audit } from '../utils/activityLogger.js';
import * as receiptService from '../services/receiptService.js';

// GET /api/receipts
export const getReceipts = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const receipts = await receiptService.getReceiptsForBusiness(req.user.businessId);
  res.json(receipts);
});

// POST /api/receipts
export const createReceipt = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const receipt = await receiptService.createReceiptForBusiness(req.user.businessId, req.body);
  audit({
    req,
    action: 'CREATE',
    resource: 'RECEIPT',
    resourceId: String((receipt as { _id: unknown })._id),
    details: {
      receiptNumber: (receipt as { receiptNumber?: string }).receiptNumber,
      amount: (receipt as { amount?: number }).amount,
    },
  });
  res.status(201).json(receipt);
});

// DELETE /api/receipts/:id
export const deleteReceipt = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await receiptService.deleteReceiptForBusiness(req.params.id!, req.user.businessId);
  audit({ req, action: 'DELETE', resource: 'RECEIPT', resourceId: req.params.id });
  res.json({ message: 'Deleted' });
});

// POST /api/receipts/:id/send-email
export const sendReceiptByEmail = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await receiptService.sendReceiptByEmailForBusiness(req.params.id!, req.user.businessId, req.body.email);
  res.json(result);
});

// GET /api/receipts/public/:token  — no auth
export const getPublicReceipt = asyncHandler(async (req: Request, res: Response) => {
  const result = await receiptService.getPublicReceiptByToken(req.params.token!);
  res.json(result);
});
