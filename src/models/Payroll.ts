import mongoose, { Schema, Document } from 'mongoose';

export interface IPayroll extends Document {
  businessId: mongoose.Types.ObjectId;
  staffName: string;
  salary: number;
  payday: Date;
  status: 'pending' | 'paid';
  staffId?: mongoose.Types.ObjectId;
  transactionId?: mongoose.Types.ObjectId;
  payslipToken?: string;
  deductions?: number;
  bonus?: number;
  note?: string;
  payPeriod?: string; // e.g. "2026-06" — YYYY-MM of the pay period
}

const PayrollSchema: Schema = new Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    staffName: { type: String, required: true, trim: true },
    salary: { type: Number, required: true },
    payday: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: false },
    payslipToken: { type: String, unique: true, sparse: true },
    deductions: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    note: { type: String },
    payPeriod: { type: String, index: true },
  },
  { timestamps: true },
);

PayrollSchema.index({ businessId: 1, createdAt: -1 });

export default mongoose.model<IPayroll>('Payroll', PayrollSchema);
