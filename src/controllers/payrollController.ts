import type { Request, Response } from 'express';
import Payroll from '../models/Payroll.js';

/**
 * @desc    Create a new payroll entry with a manual name
 * @route   POST /api/payrolls
 */
export const createPayroll = async (req: Request, res: Response) => {
  try {
    // Explicitly destructure staffName to ensure it is captured from req.body
    const { staffName, salary, payday } = req.body;

    // Validation check before attempting database insertion
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

    res.status(201).json(payroll);
  } catch (error) {
    // This catches Mongoose validation errors
    res.status(500).json({
      message: 'Failed to create payroll',
      error: (error as Error).message,
    });
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
    const payroll = await Payroll.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });

    if (payroll) {
      // Update fields only if they are provided in the request
      if (req.body.staffName) payroll.staffName = req.body.staffName;
      if (req.body.salary) payroll.salary = req.body.salary;
      if (req.body.payday) payroll.payday = req.body.payday;
      if (req.body.status) payroll.status = req.body.status;

      const updatedPayroll = await payroll.save();
      res.json(updatedPayroll);
    } else {
      res.status(404).json({ message: 'Payroll not found' });
    }
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
    const businessId = (req.user as any).businessId;
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    // Find all pending payrolls for this business due today or earlier
    const pendingPayrolls = await Payroll.find({
      businessId,
      status: 'pending',
      payday: { $lte: today },
    });

    if (pendingPayrolls.length === 0) {
      return res.json({ message: 'No pending payrolls to process.' });
    }

    // Update all found records to 'paid'
    await Payroll.updateMany(
      { _id: { $in: pendingPayrolls.map((p) => p._id) } },
      { $set: { status: 'paid' } },
    );

    res.json({ message: `${pendingPayrolls.length} payrolls marked as paid.` });
  } catch (error) {
    res.status(500).json({ message: 'Processing failed', error: (error as Error).message });
  }
};
