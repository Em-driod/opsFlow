import mongoose, { Schema, Document } from 'mongoose';

// Stores the outcome of a POST made with an `Idempotency-Key` header so a retry
// (double-click, flaky mobile network, client timeout) replays the first
// response instead of performing the operation again.
export interface IIdempotencyKey extends Document {
  businessId: mongoose.Types.ObjectId;
  key: string;
  method: string;
  path: string;
  state: 'pending' | 'completed';
  statusCode?: number;
  responseBody?: unknown;
  createdAt: Date;
}

const IdempotencyKeySchema = new Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    key: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    state: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    statusCode: { type: Number },
    responseBody: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

// One record per key per business — the unique index is what makes concurrent
// duplicates safe: only one request can insert the "pending" claim.
IdempotencyKeySchema.index({ businessId: 1, key: 1 }, { unique: true });
// Keys expire after 24h; retries after that are treated as new requests.
IdempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export default mongoose.model<IIdempotencyKey>('IdempotencyKey', IdempotencyKeySchema);
