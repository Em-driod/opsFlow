import mongoose, { Schema, Document } from 'mongoose';

export interface ISmartMapping extends Document {
  businessId: mongoose.Types.ObjectId;
  normalizedDescription: string;
  category: string;
  confidenceScore: number;
  lastSeenAt: Date;
}

const SmartMappingSchema: Schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  normalizedDescription: { type: String, required: true },
  category: { type: String, required: true },
  confidenceScore: { type: Number, default: 1 },
  lastSeenAt: { type: Date, default: Date.now }
});

// Compound index for fast lookups per business
SmartMappingSchema.index({ businessId: 1, normalizedDescription: 1 }, { unique: true });

export default mongoose.model<ISmartMapping>('SmartMapping', SmartMappingSchema);
