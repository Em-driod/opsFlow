import express from 'express';
const router = express.Router();
import {
  createPayroll,
  getPayrolls,
  getPayrollById,
  updatePayroll,
  deletePayroll,
  processPayrolls,
} from '../controllers/payrollController.js';
import { protect, admin } from '../middleware/auth.js';

// @route   POST & GET /api/payrolls
// Note: getPayrolls now includes .populate('staffId') to return names
router.route('/').post(protect, admin, createPayroll).get(protect, getPayrolls);

// @route   POST /api/payrolls/process
router.route('/process').post(protect, admin, processPayrolls);

// @route   GET, PUT, DELETE /api/payrolls/:id
router
  .route('/:id')
  .get(protect, getPayrollById)
  .put(protect, admin, updatePayroll)
  .delete(protect, admin, deletePayroll);

export default router;
