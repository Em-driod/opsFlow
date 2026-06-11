import mongoose, { Schema, Document } from 'mongoose';

export interface IBudget extends Document {
  businessId: mongoose.Types.ObjectId;
  category: string;
  monthlyLimit: number;
  isActive: boolean;
}

const BudgetSchema: Schema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    category: { type: String, required: true },
    monthlyLimit: { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

BudgetSchema.index({ businessId: 1, category: 1 }, { unique: true });

export default mongoose.model<IBudget>('Budget', BudgetSchema);
