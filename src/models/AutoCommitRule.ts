import mongoose, { Schema, Document } from 'mongoose';

export interface IAutoCommitRule extends Document {
  businessId: mongoose.Types.ObjectId;
  name: string;
  enabled: boolean;
  vendorPattern?: string;
  categories?: string[];
  maxAmount?: number;
  minConfidence: number;
  type?: 'income' | 'expense';
  defaultCategory?: string;
  createdBy: mongoose.Types.ObjectId;
  matchCount: number;
  lastMatchedAt?: Date;
}

const AutoCommitRuleSchema: Schema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    vendorPattern: { type: String },
    categories: [{ type: String }],
    maxAmount: { type: Number },
    minConfidence: { type: Number, default: 0.85, min: 0, max: 1 },
    type: { type: String, enum: ['income', 'expense'] },
    defaultCategory: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    matchCount: { type: Number, default: 0 },
    lastMatchedAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.model<IAutoCommitRule>('AutoCommitRule', AutoCommitRuleSchema);
