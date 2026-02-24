import express from 'express';
import {
  getFinancialSummary,
  getDetailedTransactions,
} from '../controllers/reportingController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/financial-summary').get(protect, getFinancialSummary);
router.route('/detailed-transactions').get(protect, getDetailedTransactions);

export default router;
