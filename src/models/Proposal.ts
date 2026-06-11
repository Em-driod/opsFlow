import mongoose, { Schema, Document } from 'mongoose';

export interface IProposal extends Document {
  proposalNumber: string;
  businessId: mongoose.Types.ObjectId;
  clientId?: mongoose.Types.ObjectId | null;
  customClientName?: string | null;
  recipientEmail?: string | null;
  title: string;
  lineItems: {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  subtotal: number;
  tax: number;
  total: number;
  validUntil: Date;
  notes?: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'converted';
  signatureName?: string;
  signedAt?: Date;
  convertedInvoiceId?: mongoose.Types.ObjectId;
}

const LineItemSchema = new Schema({
  description: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  unitPrice: { type: Number, required: true },
  total: { type: Number, required: true },
});

const ProposalSchema: Schema = new Schema(
  {
    proposalNumber: { type: String, required: true, unique: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    customClientName: { type: String, default: null },
    recipientEmail: { type: String, default: null },
    title: { type: String, required: true },
    lineItems: [LineItemSchema],
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    validUntil: { type: Date, required: true },
    notes: { type: String },
    status: {
      type: String,
      enum: ['draft', 'sent', 'accepted', 'declined', 'converted'],
      default: 'draft',
    },
    signatureName: { type: String },
    signedAt: { type: Date },
    convertedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  },
  { timestamps: true },
);

export default mongoose.model<IProposal>('Proposal', ProposalSchema);
