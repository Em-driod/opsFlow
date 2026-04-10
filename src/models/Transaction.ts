import mongoose, { Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
  clientId?: mongoose.Types.ObjectId; // Keep clientId optional
  projectId?: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  description?: string;
  recordedBy: mongoose.Types.ObjectId;
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
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export default mongoose.model<ITransaction>('Transaction', TransactionSchema);
