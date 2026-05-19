import express from 'express';
import { getMetadata, getPitSummary, exportPitCsv } from '../controllers/taxController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/metadata', protect, getMetadata);
router.get('/pit/summary', protect, getPitSummary);
router.get('/pit/export.csv', protect, exportPitCsv);

export default router;
