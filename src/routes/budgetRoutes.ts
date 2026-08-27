import express from 'express';
import { getBudgets, createBudget, updateBudget, deleteBudget, copyBudgets } from '../controllers/budgetController.js';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';

const router = express.Router();

// Budgets are financial planning config — staff may view, admins manage.
router.route('/').get(protect, getBudgets).post(protect, permit('admin'), createBudget);
router.route('/copy').post(protect, permit('admin'), copyBudgets);
router.route('/:id').put(protect, permit('admin'), updateBudget).delete(protect, permit('admin'), deleteBudget);

export default router;
