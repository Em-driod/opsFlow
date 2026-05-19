import mongoose, { Schema, Document } from 'mongoose';

export interface IPayroll extends Document {
  businessId: mongoose.Types.ObjectId;
  staffName: string;
  salary: number;
  payday: Date;
  status: 'pending' | 'paid';
  staffId?: mongoose.Types.ObjectId;
  transactionId?: mongoose.Types.ObjectId;
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
  },
  { timestamps: true },
);

export default mongoose.model<IPayroll>('Payroll', PayrollSchema);
