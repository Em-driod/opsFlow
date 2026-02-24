import express from 'express';
import {
  createScannedTransaction,
  getScannedTransactions,
  commitScannedTransaction,
  deleteScannedTransaction,
  updateParsedScanItem,
  commitAllScannedItems,
} from '../controllers/scannedTransactionController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/')
  .post(protect, createScannedTransaction)
  .get(protect, getScannedTransactions);

router.route('/:id/parsed-items/:itemIndex')
    .put(protect, updateParsedScanItem);

router.route('/:id')
    .delete(protect, deleteScannedTransaction);

router.route('/:id/commit')
    .post(protect, commitScannedTransaction);

router.route('/:id/commit-all')
    .post(protect, commitAllScannedItems);

export default router;
