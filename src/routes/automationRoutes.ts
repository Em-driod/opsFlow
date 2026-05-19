import express from 'express';
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  getLearningStats,
} from '../controllers/automationController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/rules').get(protect, listRules).post(protect, createRule);
router.route('/rules/:id').put(protect, updateRule).delete(protect, deleteRule);
router.route('/learning-stats').get(protect, getLearningStats);

export default router;
