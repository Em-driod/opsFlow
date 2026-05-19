import express from 'express';
import {
  createInvoice,
  getInvoices,
  getInvoiceById,
  updateInvoiceStatus,
  scanInvoice,
  getPublicInvoice,
  sendInvoice,
  getWhatsAppLink,
  initPaystackPayment,
  paystackWebhook,
} from '../controllers/invoiceController.js';
import { protect } from '../middleware/auth.js';
import upload from '../middleware/multer.js';

const router = express.Router();

// Public routes (no auth)
router.get('/public/:id', getPublicInvoice);
router.post('/public/:id/pay/init', initPaystackPayment);
router.post('/webhooks/paystack', paystackWebhook);

// Protected routes
router.route('/').post(protect, createInvoice).get(protect, getInvoices);
router.post('/scan', protect, upload.single('image'), scanInvoice);
router.route('/:id').get(protect, getInvoiceById);
router.route('/:id/status').put(protect, updateInvoiceStatus);
router.post('/:id/send', protect, sendInvoice);
router.post('/:id/whatsapp', protect, getWhatsAppLink);

export default router;
