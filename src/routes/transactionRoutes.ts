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
import { protect } from '../middleware/auth.js';
import upload from '../middleware/multer.js';

router.route('/').post(protect, createTransaction).get(protect, getTransactions);
router.route('/revenue-stats').get(protect, getRevenueStats);
router.post('/scan', protect, upload.single('image'), scanTransaction);
router
  .route('/:id')
  .get(protect, getTransactionById)
  .put(protect, updateTransaction)
  .delete(protect, deleteTransaction);

export default router;
