import mongoose, { Schema, Document } from 'mongoose';

export interface IClient extends Document {
  businessId?: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  transactions?: mongoose.Types.ObjectId[];
  balance?: number;
  businessValue?: number;
  status?: 'active' | 'inactive';
}

const ClientSchema: Schema = new Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: false },
    name: { type: String, required: true },
    email: { type: String, required: true }, // Not unique
    phone: { type: String },
    transactions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' }],
    balance: { type: Number, default: 0 },
    businessValue: { type: Number, default: 50 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
);

export default mongoose.model<IClient>('Client', ClientSchema);
