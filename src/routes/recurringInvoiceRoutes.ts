import express from 'express';
import {
  createRecurringInvoice,
  getRecurringInvoices,
  updateRecurringInvoice,
  deleteRecurringInvoice,
} from '../controllers/recurringInvoiceController.js';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';

const router = express.Router();

router.route('/')
  .post(protect, createRecurringInvoice)
  .get(protect, getRecurringInvoices);

router.route('/:id')
  .put(protect, updateRecurringInvoice)
  .delete(protect, permit('admin'), deleteRecurringInvoice);

export default router;
