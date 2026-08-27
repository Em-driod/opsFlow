import express from 'express';
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  getLearningStats,
} from '../controllers/automationController.js';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';

const router = express.Router();

// Automation rules auto-post transactions — staff view, admins manage.
router.route('/rules').get(protect, listRules).post(protect, permit('admin'), createRule);
router.route('/rules/:id').put(protect, permit('admin'), updateRule).delete(protect, permit('admin'), deleteRule);
router.route('/learning-stats').get(protect, getLearningStats);

export default router;
