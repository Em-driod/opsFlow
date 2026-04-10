import mongoose, { Schema, Document } from 'mongoose';

// Webhook subscription config
const WebhookSchema: Schema = new Schema({
  id: { type: String, required: true },
  url: { type: String, required: true },
  events: [{ type: String }], // e.g. ['transaction.created', 'invoice.created']
  secret: { type: String },   // HMAC signing secret
  active: { type: Boolean, default: true },
  lastTriggeredAt: { type: Date },
  failureCount: { type: Number, default: 0 },
});

// Sync event log entry
const SyncEventSchema: Schema = new Schema({
  type: { type: String }, // 'transaction' | 'client' | 'invoice' | 'payroll'
  action: { type: String }, // 'created' | 'updated'
  recordId: { type: String },
  status: { type: String, enum: ['synced', 'pending', 'failed'], default: 'pending' },
  error: { type: String },
  syncedAt: { type: Date, default: Date.now },
});

export interface IExportConfig extends Document {
  businessId: mongoose.Types.ObjectId;
  googleSheetId: string;
  googleSheetUrl: string;
  sheetsConnected: boolean;
  autoSyncEnabled: boolean;
  lastFullSyncAt?: Date;
  syncEvents: any[];
  webhooks: any[];
}

const ExportConfigSchema: Schema = new Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      unique: true,
    },
    googleSheetId: { type: String, default: '' },
    googleSheetUrl: { type: String, default: '' },
    sheetsConnected: { type: Boolean, default: false },
    autoSyncEnabled: { type: Boolean, default: true },
    lastFullSyncAt: { type: Date },
    syncEvents: { type: [SyncEventSchema], default: [] },
    webhooks: { type: [WebhookSchema], default: [] },
  },
  { timestamps: true },
);

export default mongoose.model<IExportConfig>('ExportConfig', ExportConfigSchema);
