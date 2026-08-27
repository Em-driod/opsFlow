import express from 'express';
import {
  getReceipts,
  createReceipt,
  deleteReceipt,
  sendReceiptByEmail,
  getPublicReceipt,
} from '../controllers/receiptController.js';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';

const router = express.Router();

// Public — no auth
router.get('/public/:token', getPublicReceipt as express.RequestHandler);

// Protected
router.route('/').get(protect, getReceipts as express.RequestHandler).post(protect, createReceipt as express.RequestHandler);
router.delete('/:id', protect, permit('admin'), deleteReceipt as express.RequestHandler);
router.post('/:id/send-email', protect, sendReceiptByEmail as express.RequestHandler);

export default router;
