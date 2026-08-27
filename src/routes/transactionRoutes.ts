import express from 'express';
const router = express.Router();
import {
  createTransaction,
  getTransactions,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  getRevenueStats,
  scanTransaction,
} from '../controllers/transactionController.js';
import { previewCsv, commitCsv } from '../controllers/csvImportController.js';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';
import { validate } from '../middleware/validate.js';
import { createTransactionSchema } from '../middleware/schemas.js';
import upload from '../middleware/multer.js';

router.route('/').post(protect, validate(createTransactionSchema), createTransaction).get(protect, getTransactions);
router.route('/revenue-stats').get(protect, getRevenueStats);
router.post('/scan', protect, upload.single('image'), scanTransaction);
router.post('/csv/preview', protect, previewCsv);
router.post('/csv/commit', protect, commitCsv);
router
  .route('/:id')
  .get(protect, getTransactionById)
  .put(protect, updateTransaction)
  .delete(protect, permit('admin'), deleteTransaction);

export default router;
