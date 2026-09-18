import mongoose, { Schema, Document } from 'mongoose';

export interface IIntegrationKey extends Document {
  businessId: mongoose.Types.ObjectId;
  /** SHA-256 hex of the raw key. The raw key is shown to the user exactly once. */
  keyHash: string;
  /** First chars of the raw key, for display in the UI (e.g. "mgk_live_1a2b3c4d"). */
  keyPrefix: string;
  /** Free-text name the owner gave the key, e.g. "Foige". */
  label: string;
  createdBy: mongoose.Types.ObjectId;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const IntegrationKeySchema = new Schema<IIntegrationKey>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    keyHash: { type: String, required: true, unique: true },
    keyPrefix: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.model<IIntegrationKey>('IntegrationKey', IntegrationKeySchema);
