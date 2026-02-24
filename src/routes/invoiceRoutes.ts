import express from 'express';
import {
  createInvoice,
  getInvoices,
  getInvoiceById,
  updateInvoiceStatus,
  scanInvoice,
} from '../controllers/invoiceController.js';
import { protect } from '../middleware/auth.js';
import upload from '../middleware/multer.js';

const router = express.Router();

router.route('/').post(protect, createInvoice).get(protect, getInvoices);
router.post('/scan', protect, upload.single('image'), scanInvoice);

router.route('/:id').get(protect, getInvoiceById);

router.route('/:id/status').put(protect, updateInvoiceStatus);

export default router;
