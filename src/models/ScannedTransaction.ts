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
    status: 'pending' | 'committed' | 'edited';
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
        status: { type: String, enum: ['pending', 'committed', 'edited'], default: 'pending' },
      },
    ],
  },
  { timestamps: true },
);

export default mongoose.model<IScannedTransaction>('ScannedTransaction', ScannedTransactionSchema);
