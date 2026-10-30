import mongoose, { Schema, Document } from 'mongoose';
import { snapshotUnitCosts } from '../utils/productCost.js';
import { uniquePaymentCode } from '../utils/paymentCode.js';

export interface IInvoicePayment {
  amount: number;
  date: Date;
  method: string;
  transactionId: mongoose.Types.ObjectId;
  note?: string;
  // Payment-gateway reference (e.g. Paystack). Used to make webhook processing idempotent.
  reference?: string;
}

export interface IInvoice extends Document {
  invoiceNumber: string;
  businessId: mongoose.Types.ObjectId;
  clientId?: mongoose.Types.ObjectId | null;
  customClientName?: string | null;
  recipientEmail?: string | null;
  lineItems: {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    productId?: mongoose.Types.ObjectId;
    // Cost per unit at the time of sale (see utils/productCost.ts). select:false.
    unitCost?: number;
  }[];
  subtotal: number;
  tax: number;
  total: number;
  status: 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'void';
  dueDate: Date;
  notes?: string;
  transactionId?: mongoose.Types.ObjectId | undefined;
  payments: IInvoicePayment[];
  // Short code the client puts in their bank transfer, e.g. "IV3HX9QT".
  paymentCode?: string;
  // When the client tapped "I've sent the money" — a nudge to check, not proof.
  customerMarkedPaidAt?: Date;
  // Virtuals (computed, not stored)
  amountPaid: number;
  balance: number;
}

const LineItemSchema: Schema = new Schema({
  description: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  unitPrice: { type: Number, required: true },
  total: { type: Number, required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  // Hidden by default: invoices are shown to clients (public link, client
  // portal), and they must never see what the item cost the business.
  unitCost: { type: Number, min: 0, select: false },
});

const InvoicePaymentSchema: Schema = new Schema(
  {
    amount: { type: Number, required: true },
    date: { type: Date, required: true, default: Date.now },
    method: { type: String, default: 'manual' },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    note: { type: String },
    reference: { type: String },
  },
  { _id: false },
);

const InvoiceSchema: Schema = new Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    customClientName: { type: String, default: null },
    recipientEmail: { type: String, default: null },
    lineItems: [LineItemSchema],
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    status: { type: String, enum: ['draft', 'sent', 'partial', 'paid', 'overdue', 'void'], default: 'draft' },
    dueDate: { type: Date, required: true },
    notes: { type: String },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    payments: { type: [InvoicePaymentSchema], default: [] },
    paymentCode: { type: String, index: { unique: true, sparse: true } },
    customerMarkedPaidAt: { type: Date },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

InvoiceSchema.index({ businessId: 1, createdAt: -1 });
InvoiceSchema.index({ businessId: 1, status: 1 });

// amountPaid/balance are derived from the payments log, not stored, so they
// can never drift out of sync with it. Invoices marked "paid" before this
// field existed have no payments entries — treated as fully paid for display.
InvoiceSchema.virtual('amountPaid').get(function (this: IInvoice) {
  const recorded = (this.payments || []).reduce((sum, p) => sum + p.amount, 0);
  return recorded > 0 ? recorded : this.status === 'paid' ? this.total : 0;
});

InvoiceSchema.virtual('balance').get(function (this: IInvoice) {
  const recorded = (this.payments || []).reduce((sum, p) => sum + p.amount, 0);
  const amountPaid = recorded > 0 ? recorded : this.status === 'paid' ? this.total : 0;
  return Math.max(0, this.total - amountPaid);
});

// Every creation path (manual, proposal conversion, recurring) goes through save,
// so this is the one place sale-time costs are captured.
InvoiceSchema.pre('save', async function () {
  const invoice = this as unknown as IInvoice;
  if (!invoice.isNew) return;
  await snapshotUnitCosts(invoice.businessId, invoice.lineItems, invoice.$session());
  if (!invoice.paymentCode) {
    invoice.paymentCode = await uniquePaymentCode('IV', (code) => mongoose.model('Invoice').exists({ paymentCode: code }));
  }
});

export default mongoose.model<IInvoice>('Invoice', InvoiceSchema);
