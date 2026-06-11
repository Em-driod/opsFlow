import mongoose, { Schema, Document } from 'mongoose';

export interface IReceipt extends Document {
  receiptNumber: string;
  businessId: mongoose.Types.ObjectId;
  transactionId?: mongoose.Types.ObjectId;
  payerName: string;
  payerEmail?: string;
  payerPhone?: string;
  amount: number;
  currency: string;
  description: string;
  date: Date;
  publicToken: string;
  notes?: string;
  createdAt: Date;
}

const ReceiptSchema: Schema = new Schema(
  {
    receiptNumber: { type: String, required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    payerName: { type: String, required: true },
    payerEmail: { type: String },
    payerPhone: { type: String },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'NGN' },
    description: { type: String, required: true },
    date: { type: Date, default: Date.now },
    publicToken: { type: String, required: true, unique: true },
    notes: { type: String },
  },
  { timestamps: true }
);

ReceiptSchema.index({ businessId: 1, createdAt: -1 });

export default mongoose.model<IReceipt>('Receipt', ReceiptSchema);
