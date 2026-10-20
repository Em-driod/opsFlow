import mongoose, { Schema, Document } from 'mongoose';
import { snapshotUnitCosts } from '../utils/productCost.js';

export interface IReceiptItem {
  description: string;
  amount: number;
  productId?: mongoose.Types.ObjectId;
  quantity?: number;
  // The transaction this line was built from, if any — lets the profit report
  // skip lines that just re-state an invoice payment (already counted there).
  transactionId?: mongoose.Types.ObjectId;
  // Cost per unit at the time of sale (see utils/productCost.ts). select:false.
  unitCost?: number;
}

export interface IReceipt extends Document {
  receiptNumber: string;
  businessId: mongoose.Types.ObjectId;
  transactionId?: mongoose.Types.ObjectId;
  transactionIds: mongoose.Types.ObjectId[];
  items: IReceiptItem[];
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

const ReceiptItemSchema = new Schema<IReceiptItem>(
  {
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    // Hidden by default: receipts are public via their share link.
    unitCost: { type: Number, min: 0, select: false },
  },
  { _id: false }
);

const ReceiptSchema: Schema = new Schema(
  {
    receiptNumber: { type: String, required: true, unique: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    transactionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' }],
    items: { type: [ReceiptItemSchema], default: [] },
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

ReceiptSchema.pre('save', async function () {
  const receipt = this as unknown as IReceipt;
  if (!receipt.isNew) return;
  await snapshotUnitCosts(receipt.businessId, receipt.items, receipt.$session());
});

export default mongoose.model<IReceipt>('Receipt', ReceiptSchema);
