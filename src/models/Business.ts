import mongoose, { Schema, Document } from 'mongoose';

export interface IServiceItem {
  name: string;
  description?: string;
  price?: number;
}

export interface IBusinessProfile {
  tagline?: string;
  description?: string;
  whatsapp?: string;
  email?: string;
  website?: string;
  instagram?: string;
  location?: string;
  services: IServiceItem[];
  isPublic: boolean;
}

export interface IBusiness extends Document {
  name: string;
  owner: mongoose.Types.ObjectId;
  users: mongoose.Types.ObjectId[];
  clients: mongoose.Types.ObjectId[];
  currency: string;
  slug?: string;
  profile: IBusinessProfile;
}

const ServiceItemSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String },
  price: { type: Number },
}, { _id: false });

const BusinessSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    clients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client' }],
    currency: { type: String, required: true, default: 'USD' },
    slug: { type: String, unique: true, sparse: true },
    profile: {
      tagline: { type: String },
      description: { type: String },
      whatsapp: { type: String },
      email: { type: String },
      website: { type: String },
      instagram: { type: String },
      location: { type: String },
      services: { type: [ServiceItemSchema], default: [] },
      isPublic: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

export default mongoose.model<IBusiness>('Business', BusinessSchema);
