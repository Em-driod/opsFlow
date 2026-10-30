import mongoose, { Schema, Document } from 'mongoose';

export type CreditSource = 'email_alert' | 'mono';
export type CreditStatus = 'matched' | 'unmatched' | 'dismissed';

// One money-in event seen on a business's bank account — from a forwarded
// bank alert email or a linked bank feed. Kept whether or not it matched an
// order, so the owner can match leftovers by hand and so the same event is
// never processed twice.
export interface IBankCredit extends Document {
  businessId: mongoose.Types.ObjectId;
  source: CreditSource;
  // The sender's own id for the event (email Message-ID / hash, Mono txn id).
  externalId: string;
  amount: number;
  narration?: string;
  receivedAt: Date;
  status: CreditStatus;
  orderId?: mongoose.Types.ObjectId;
  // Set when a code matched but the amount was short — shown as a hint.
  suggestedOrderId?: mongoose.Types.ObjectId;
  // Invoices are paid by transfer too; a credit can settle (part of) one.
  invoiceId?: mongoose.Types.ObjectId;
  suggestedInvoiceId?: mongoose.Types.ObjectId;
  note?: string;
  createdAt: Date;
}

const BankCreditSchema = new Schema<IBankCredit>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    source: { type: String, enum: ['email_alert', 'mono'], required: true },
    externalId: { type: String, required: true },
    amount: { type: Number, required: true },
    narration: { type: String },
    receivedAt: { type: Date, required: true },
    status: { type: String, enum: ['matched', 'unmatched', 'dismissed'], default: 'unmatched' },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    suggestedOrderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    suggestedInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    note: { type: String },
  },
  { timestamps: true },
);

// The same alert or feed transaction can arrive more than once.
BankCreditSchema.index({ businessId: 1, source: 1, externalId: 1 }, { unique: true });
BankCreditSchema.index({ businessId: 1, status: 1, receivedAt: -1 });

export default mongoose.model<IBankCredit>('BankCredit', BankCreditSchema);
