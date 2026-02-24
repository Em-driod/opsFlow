import express from 'express';
import { getKpis, getChartData } from '../controllers/dashboardController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/kpis').get(protect, getKpis);
router.route('/chart-data').get(protect, getChartData);

export default router;
