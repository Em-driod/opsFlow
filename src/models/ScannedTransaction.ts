import mongoose, { Schema, Document } from 'mongoose';

export interface IScannedTransaction extends Document {
  businessId: mongoose.Types.ObjectId;
  rawText: string;
  originalFileName: string;
  status: 'pending' | 'processed';
  recordedBy: mongoose.Types.ObjectId;
  parsedDetails: Array<{
    amount: number;
    type: 'income' | 'expense' | 'unassigned';
    category: string;
    description?: string;
    status: 'pending' | 'committed' | 'edited' | 'auto_committed';
    confidence?: number;
    autoRuleId?: mongoose.Types.ObjectId;
  }>;
}

const ScannedTransactionSchema: Schema = new Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    rawText: { type: String, required: true },
    originalFileName: { type: String },
    status: { type: String, enum: ['pending', 'processed'], default: 'pending' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    parsedDetails: [
      {
        amount: { type: Number, required: true },
        type: { type: String, enum: ['income', 'expense', 'unassigned'], default: 'unassigned' },
        category: { type: String },
        description: { type: String },
        status: { type: String, enum: ['pending', 'committed', 'edited', 'auto_committed'], default: 'pending' },
        confidence: { type: Number },
        autoRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'AutoCommitRule' },
      },
    ],
  },
  { timestamps: true },
);

export default mongoose.model<IScannedTransaction>('ScannedTransaction', ScannedTransactionSchema);
