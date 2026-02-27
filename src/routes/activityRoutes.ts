import express from 'express';
const router = express.Router();
import {
  getActivityLogs,
  getActivityStats,
} from '../controllers/activityController.js';
import { protect, admin } from '../middleware/auth.js';

router.route('/').get(protect, admin, getActivityLogs);
router.route('/stats').get(protect, admin, getActivityStats);

export default router;
