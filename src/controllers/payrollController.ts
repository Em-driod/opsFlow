import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as payrollService from '../services/payrollService.js';

/**
 * @desc    Create a new payroll entry with a manual name
 * @route   POST /api/payrolls
 */
export const createPayroll = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const payroll = await payrollService.createPayrollForBusiness(req.user.businessId, req.body);
  res.status(201).json(payroll);
});

/**
 * @desc    Get all payrolls for a business (no population needed)
 * @route   GET /api/payrolls
 */
export const getPayrolls = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const payrolls = await payrollService.getPayrollsForBusiness(req.user.businessId);
  res.json(payrolls);
});

/**
 * @desc    Get payroll by ID
 * @route   GET /api/payrolls/:id
 */
export const getPayrollById = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const payroll = await payrollService.getPayrollByIdForBusiness(req.params.id!, req.user.businessId);
  res.json(payroll);
});

/**
 * @desc    Update payroll (Manual Name, Salary, or Status)
 * @route   PUT /api/payrolls/:id
 */
export const updatePayroll = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const updatedPayroll = await payrollService.updatePayrollForBusiness(req.params.id!, req.user, req.body);
  res.json(updatedPayroll);
});

/**
 * @desc    Delete payroll
 * @route   DELETE /api/payrolls/:id
 */
export const deletePayroll = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await payrollService.deletePayrollForBusiness(req.params.id!, req.user.businessId);
  res.json({ message: 'Payroll entry deleted successfully' });
});

/**
 * @desc    Process pending payrolls (Set status to paid)
 * @route   POST /api/payrolls/process
 */
export const processPayrolls = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await payrollService.processPendingPayrollsForBusiness(req.user);
  res.json(result);
});

// POST /api/payrolls/:id/payslip — generate (or return existing) payslip token
export const generatePayslip = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const token = await payrollService.generatePayslipForBusiness(req.params.id!, req.user.businessId);
  res.json({ token });
});

// GET /api/payrolls/payslip/:token — public, no auth
export const getPublicPayslip = asyncHandler(async (req: Request, res: Response) => {
  const result = await payrollService.getPublicPayslipByToken(req.params.token!);
  res.json(result);
});
