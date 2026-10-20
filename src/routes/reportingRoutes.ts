import express from 'express';
import {
  getFinancialSummary,
  getDetailedTransactions,
  getMonthlyTrend,
  getProductProfit,
  linkSalesToProduct,
} from '../controllers/reportingController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/financial-summary').get(protect, getFinancialSummary);
router.route('/detailed-transactions').get(protect, getDetailedTransactions);
router.route('/monthly-trend').get(protect, getMonthlyTrend);
router.route('/product-profit').get(protect, getProductProfit);
router.route('/product-profit/link').post(protect, linkSalesToProduct);

export default router;
