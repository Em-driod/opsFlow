import mongoose, { Schema, Document } from 'mongoose';

export interface IServiceItem {
  name: string;
  description?: string;
  price?: number;
  image?: string;
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
  coverImage?: string;
  logoImage?: string;
  accentColor?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  bankName2?: string;
  accountNumber2?: string;
  accountName2?: string;
}

// Online ordering + how payments into the business's own bank account are
// detected. Lives outside `profile` because the profile save rebuilds that
// object wholesale.
export interface IPaymentSettings {
  ordersEnabled: boolean;
  // Secret part of the business's alert-forwarding address (pay-<token>@domain).
  alertToken?: string;
  lastAlertAt?: Date;
  // Gmail asks the forwarding address to confirm before it forwards anything.
  forwardingVerification?: { code?: string; link?: string; receivedAt: Date };
  recentAlerts: { subject: string; receivedAt: Date; outcome: string }[];
  mono?: {
    accountId: string;
    accountName?: string;
    accountNumber?: string;
    institution?: string;
    linkedAt: Date;
    lastSyncedAt?: Date;
    lastError?: string;
  };
}

export interface IBusiness extends Document {
  name: string;
  owner: mongoose.Types.ObjectId;
  users: mongoose.Types.ObjectId[];
  clients: mongoose.Types.ObjectId[];
  currency: string;
  slug?: string;
  profile: IBusinessProfile;
  profileViews: number;
  payments?: IPaymentSettings;
  updatedAt?: Date;
}

const ServiceItemSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String },
  price: { type: Number },
  image: { type: String },
}, { _id: false });

const BusinessSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    clients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client' }],
    currency: { type: String, required: true, default: 'USD' },
    slug: { type: String, unique: true, sparse: true },
    profileViews: { type: Number, default: 0 },
    payments: {
      ordersEnabled: { type: Boolean, default: false },
      alertToken: { type: String, index: { unique: true, sparse: true } },
      lastAlertAt: { type: Date },
      forwardingVerification: {
        code: { type: String },
        link: { type: String },
        receivedAt: { type: Date },
      },
      recentAlerts: {
        type: [{ _id: false, subject: String, receivedAt: Date, outcome: String }],
        default: [],
      },
      mono: {
        accountId: { type: String, index: { sparse: true } },
        accountName: { type: String },
        accountNumber: { type: String },
        institution: { type: String },
        linkedAt: { type: Date },
        lastSyncedAt: { type: Date },
        lastError: { type: String },
      },
    },
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
      coverImage: { type: String },
      logoImage: { type: String },
      accentColor: { type: String, default: '#6366f1' },
      bankName: { type: String },
      accountNumber: { type: String },
      accountName: { type: String },
      bankName2: { type: String },
      accountNumber2: { type: String },
      accountName2: { type: String },
    },
  },
  { timestamps: true },
);

export default mongoose.model<IBusiness>('Business', BusinessSchema);
