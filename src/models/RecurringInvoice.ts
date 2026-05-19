import mongoose, { Schema, Document } from 'mongoose';

export interface IRecurringInvoice extends Document {
  businessId: mongoose.Types.ObjectId;
  clientId?: mongoose.Types.ObjectId | null;
  customClientName?: string | null;
  recipientEmail?: string | null;
  lineItems: {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  dayOfMonth?: number;
  nextRunDate: Date;
  lastRunDate?: Date;
  isActive: boolean;
  dueDaysAfter: number;
}

const LineItemSchema = new Schema({
  description: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  unitPrice: { type: Number, required: true },
  total: { type: Number, required: true },
});

const RecurringInvoiceSchema: Schema = new Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    customClientName: { type: String, default: null },
    recipientEmail: { type: String, default: null },
    lineItems: [LineItemSchema],
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    notes: { type: String },
    frequency: { type: String, enum: ['weekly', 'monthly', 'quarterly', 'yearly'], required: true },
    dayOfMonth: { type: Number },
    nextRunDate: { type: Date, required: true },
    lastRunDate: { type: Date },
    isActive: { type: Boolean, default: true },
    dueDaysAfter: { type: Number, default: 7 },
  },
  { timestamps: true },
);

export default mongoose.model<IRecurringInvoice>('RecurringInvoice', RecurringInvoiceSchema);
