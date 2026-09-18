import mongoose, { Schema, Document } from 'mongoose';
import { TAX_CATEGORIES, type NigerianTaxCategory } from '../services/nigerianTax.js';

export interface ITransaction extends Document {
  clientId?: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  description?: string;
  date: Date;
  recordedBy: mongoose.Types.ObjectId;

  // ─── Tax Fields (Nigerian PIT/CIT/VAT) ────────────────────────────────────
  // taxCategory rolls free-text `category` into a closed enum that maps to
  // FIRS/PITA-recognised treatment (allowable, relief-deductible, disallowed,
  // capital-expenditure, or income).
  taxCategory?: NigerianTaxCategory;
  vatable?: boolean;       // does this line carry VAT?
  vatAmount?: number;      // input/output VAT (NGN) — sign matches type

  // ─── Bank Sync Fields (Future-Proofing for Plaid / Open Banking) ───────────
  plaidTransactionId?: string;
  bankAccountId?: string;
  isReconciled?: boolean;
  source?: 'manual' | 'bank_sync' | 'ocr_scan' | 'csv_import' | 'integration';
  receiptImage?: string;

  // ─── External Integration Fields (generic — not tied to any one provider) ──
  // When `source === 'integration'`, `externalSource` names the sending system
  // (e.g. "foige") and `externalId` is that system's own id for the record.
  // The pair is unique per business so repeated deliveries are idempotent.
  externalSource?: string;
  externalId?: string;

  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema: Schema = new Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: false },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: false },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    amount: { type: Number, required: true },
    type: { type: String, enum: ['income', 'expense'], required: true },
    category: { type: String },
    description: { type: String },
    // The date the transaction actually happened (user-editable), distinct from
    // createdAt (when the record was inserted). Reports filter by this field.
    date: { type: Date, required: true, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Nigerian tax fields
    taxCategory: { type: String, enum: TAX_CATEGORIES },
    vatable: { type: Boolean, default: false },
    vatAmount: { type: Number, default: 0 },

    // Bank sync fields
    plaidTransactionId: { type: String, sparse: true, unique: true },
    bankAccountId: { type: String, required: false },
    isReconciled: { type: Boolean, default: false },
    source: {
      type: String,
      enum: ['manual', 'bank_sync', 'ocr_scan', 'csv_import', 'integration'],
      default: 'manual',
    },
    receiptImage: { type: String },
    externalSource: { type: String },
    externalId: { type: String },
  },
  { timestamps: true },
);

// Index for fast bank-sync deduplication lookups
TransactionSchema.index({ businessId: 1, createdAt: -1 });
TransactionSchema.index({ businessId: 1, date: -1 });
TransactionSchema.index({ plaidTransactionId: 1 }, { sparse: true });

// Idempotency guard for integration ingestion: one (business, externalSource,
// externalId) triple can only ever produce a single transaction. `partialFilter`
// keeps the constraint off the millions of manual rows that have no externalId.
TransactionSchema.index(
  { businessId: 1, externalSource: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
);

export default mongoose.model<ITransaction>('Transaction', TransactionSchema);
