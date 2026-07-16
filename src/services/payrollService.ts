import mongoose from 'mongoose';
import crypto from 'crypto';
import Payroll from '../models/Payroll.js';
import Transaction from '../models/Transaction.js';
import { enqueue } from './exportQueueService.js';
import { fire } from './webhookService.js';
import { emitToBusiness } from './socketService.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

export const createPayrollForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { staffName: string; salary: number; payday?: string; deductions?: number; bonus?: number; note?: string },
) => {
  const { staffName, salary, payday, deductions, bonus, note } = params;
  if (!staffName) throw new AppError('Employee name (staffName) is required', 400);

  const paydayDate = payday ? new Date(payday) : new Date();
  const payPeriod = `${paydayDate.getFullYear()}-${String(paydayDate.getMonth() + 1).padStart(2, '0')}`;

  const payroll = await Payroll.create({
    businessId,
    staffName,
    salary,
    payday,
    status: 'pending',
    deductions: deductions ?? 0,
    bonus: bonus ?? 0,
    note: note || undefined,
    payPeriod,
  });

  enqueue({ type: 'payroll', action: 'created', data: payroll.toObject(), businessId: String(businessId) });
  fire('payroll.created', String(businessId), payroll.toObject());

  return payroll;
};

export const getPayrollsForBusiness = (businessId: mongoose.Types.ObjectId) =>
  Payroll.find({ businessId }).sort({ payday: -1 });

export const getPayrollByIdForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const payroll = await Payroll.findOne({ _id: id, businessId });
  if (!payroll) throw new AppError('Payroll record not found', 404);
  return payroll;
};

export const updatePayrollForBusiness = async (
  id: string,
  user: IUser,
  updates: { staffName?: string; salary?: number; payday?: string; status?: string },
) => {
  const payroll = await Payroll.findOne({ _id: id, businessId: user.businessId });
  if (!payroll) throw new AppError('Payroll not found', 404);

  if (updates.staffName) payroll.staffName = updates.staffName;
  if (updates.salary) payroll.salary = updates.salary;
  if (updates.payday) payroll.payday = new Date(updates.payday);

  // When transitioning to paid for the first time, create the expense transaction
  // so payroll costs appear in the financial model.
  if (updates.status === 'paid' && payroll.status !== 'paid' && !payroll.transactionId) {
    const expenseTransaction = await Transaction.create({
      businessId: user.businessId,
      amount: payroll.salary,
      type: 'expense',
      category: 'Payroll',
      description: `Salary payment — ${payroll.staffName}`,
      recordedBy: user._id,
      source: 'manual',
    });
    payroll.transactionId = expenseTransaction._id as mongoose.Types.ObjectId;
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'created' });
  }

  if (updates.status) payroll.status = updates.status as 'pending' | 'paid';

  const updatedPayroll = await payroll.save();

  enqueue({ type: 'payroll', action: 'updated', data: updatedPayroll.toObject(), businessId: String(user.businessId) });
  fire('payroll.updated', String(user.businessId), updatedPayroll.toObject());

  return updatedPayroll;
};

export const deletePayrollForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const payroll = await Payroll.findOneAndDelete({ _id: id, businessId });
  if (!payroll) throw new AppError('Payroll not found', 404);
  return payroll;
};

export const processPendingPayrollsForBusiness = async (user: IUser) => {
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const pendingPayrolls = await Payroll.find({
    businessId: user.businessId,
    status: 'pending',
    payday: { $lte: today },
  });

  if (pendingPayrolls.length === 0) return { message: 'No pending payrolls to process.' };

  for (const payroll of pendingPayrolls) {
    if (!payroll.transactionId) {
      const expenseTransaction = await Transaction.create({
        businessId: user.businessId,
        amount: payroll.salary,
        type: 'expense',
        category: 'Payroll',
        description: `Salary payment — ${payroll.staffName}`,
        recordedBy: user._id,
        source: 'manual',
      });
      payroll.transactionId = expenseTransaction._id as mongoose.Types.ObjectId;
    }
    payroll.status = 'paid';
    await payroll.save();
  }

  emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'created' });

  return { message: `${pendingPayrolls.length} payrolls marked as paid.` };
};

export const generatePayslipForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const payroll = await Payroll.findOne({ _id: id, businessId });
  if (!payroll) throw new AppError('Payroll not found', 404);

  if (!payroll.payslipToken) {
    payroll.payslipToken = crypto.randomBytes(20).toString('hex');
    await payroll.save();
  }

  return payroll.payslipToken;
};

export const getPublicPayslipByToken = async (token: string) => {
  const payroll = await Payroll.findOne({ payslipToken: token }).populate<{
    businessId: { name: string; currency: string; profile?: { logoImage?: string; accentColor?: string } } | null;
  }>('businessId', 'name currency profile');
  if (!payroll) throw new AppError('Payslip not found', 404);

  const biz = payroll.businessId;
  return {
    staffName: payroll.staffName,
    salary: payroll.salary,
    deductions: payroll.deductions || 0,
    bonus: payroll.bonus || 0,
    netPay: payroll.salary - (payroll.deductions || 0) + (payroll.bonus || 0),
    payday: payroll.payday,
    status: payroll.status,
    note: payroll.note,
    business: {
      name: biz?.name,
      currency: biz?.currency || 'NGN',
      logoImage: biz?.profile?.logoImage,
      accentColor: biz?.profile?.accentColor,
    },
  };
};
