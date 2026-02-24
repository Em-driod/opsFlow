import mongoose, { Schema, Document } from 'mongoose';

export interface IBusiness extends Document {
  name: string;
  owner: mongoose.Types.ObjectId;
  users: mongoose.Types.ObjectId[];
  clients: mongoose.Types.ObjectId[];
  currency: string;
}

const BusinessSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    clients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client' }],
    currency: { type: String, required: true, default: 'USD' },
  },
  { timestamps: true },
);

export default mongoose.model<IBusiness>('Business', BusinessSchema);
