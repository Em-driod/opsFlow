import type { Request, Response } from 'express';
import Payroll from '../models/Payroll.js';
import Transaction from '../models/Transaction.js';
import { enqueue } from '../services/exportQueueService.js';
import { fire } from '../services/webhookService.js';
import { emitToBusiness } from '../services/socketService.js';

/**
 * @desc    Create a new payroll entry with a manual name
 * @route   POST /api/payrolls
 */
export const createPayroll = async (req: Request, res: Response) => {
  try {
    const { staffName, salary, payday } = req.body;

    if (!staffName) {
      return res.status(400).json({ message: 'Employee name (staffName) is required' });
    }

    const payroll = await Payroll.create({
      businessId: (req.user as any).businessId,
      staffName,
      salary,
      payday,
      status: 'pending',
    });

    // 🔄 Auto-sync to Google Sheets + fire webhook
    enqueue({ type: 'payroll', action: 'created', data: payroll.toObject(), businessId: String((req.user as any).businessId) });
    fire('payroll.created', String((req.user as any).businessId), payroll.toObject());

    res.status(201).json(payroll);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create payroll', error: (error as Error).message });
    console.error('Error creating payroll:', error);
  }
};

/**
 * @desc    Get all payrolls for a business (no population needed)
 * @route   GET /api/payrolls
 */
export const getPayrolls = async (req: Request, res: Response) => {
  try {
    const payrolls = await Payroll.find({
      businessId: (req.user as any).businessId,
    }).sort({ payday: -1 });

    res.json(payrolls);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

/**
 * @desc    Get payroll by ID
 * @route   GET /api/payrolls/:id
 */
export const getPayrollById = async (req: Request, res: Response) => {
  try {
    const payroll = await Payroll.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });

    if (payroll) {
      res.json(payroll);
    } else {
      res.status(404).json({ message: 'Payroll record not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc    Update payroll (Manual Name, Salary, or Status)
 * @route   PUT /api/payrolls/:id
 */
export const updatePayroll = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const payroll = await Payroll.findOne({
      _id: req.params.id,
      businessId: user.businessId,
    });

    if (!payroll) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    if (req.body.staffName) payroll.staffName = req.body.staffName;
    if (req.body.salary) payroll.salary = req.body.salary;
    if (req.body.payday) payroll.payday = req.body.payday;

    // When transitioning to paid for the first time, create the expense transaction
    // so payroll costs appear in the financial model.
    if (req.body.status === 'paid' && payroll.status !== 'paid' && !payroll.transactionId) {
      const expenseTransaction = await Transaction.create({
        businessId: user.businessId,
        amount: payroll.salary,
        type: 'expense',
        category: 'Payroll',
        description: `Salary payment — ${payroll.staffName}`,
        recordedBy: user._id,
        source: 'manual',
      });
      payroll.transactionId = expenseTransaction._id as any;
      emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'created' });
    }

    if (req.body.status) payroll.status = req.body.status;

    const updatedPayroll = await payroll.save();

    enqueue({ type: 'payroll', action: 'updated', data: updatedPayroll.toObject(), businessId: String(user.businessId) });
    fire('payroll.updated', String(user.businessId), updatedPayroll.toObject());

    res.json(updatedPayroll);
  } catch (error) {
    res.status(500).json({ message: 'Update failed', error: (error as Error).message });
  }
};

/**
 * @desc    Delete payroll
 * @route   DELETE /api/payrolls/:id
 */
export const deletePayroll = async (req: Request, res: Response) => {
  try {
    const payroll = await Payroll.findOneAndDelete({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });

    if (payroll) {
      res.json({ message: 'Payroll entry deleted successfully' });
    } else {
      res.status(404).json({ message: 'Payroll not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Deletion failed' });
  }
};

/**
 * @desc    Process pending payrolls (Set status to paid)
 * @route   POST /api/payrolls/process
 */
export const processPayrolls = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const pendingPayrolls = await Payroll.find({
      businessId: user.businessId,
      status: 'pending',
      payday: { $lte: today },
    });

    if (pendingPayrolls.length === 0) {
      return res.json({ message: 'No pending payrolls to process.' });
    }

    // Process one by one so each creates its expense transaction.
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
        payroll.transactionId = expenseTransaction._id as any;
      }
      payroll.status = 'paid';
      await payroll.save();
    }

    emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'created' });

    res.json({ message: `${pendingPayrolls.length} payrolls marked as paid.` });
  } catch (error) {
    res.status(500).json({ message: 'Processing failed', error: (error as Error).message });
  }
};
