import mongoose, { Schema, Document } from 'mongoose';

export const ACTIVITY_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'VIEW',
  'SEND',
  'PAYMENT',
  'EXPORT',
] as const;

export const ACTIVITY_RESOURCES = [
  'USER',
  'CLIENT',
  'TRANSACTION',
  'INVOICE',
  'PROPOSAL',
  'RECEIPT',
  'PRODUCT',
  'PROJECT',
  'BUDGET',
  'CAPITAL_ASSET',
  'AUTOMATION_RULE',
  'BUSINESS',
  'PAYROLL',
  'EXPORT',
  'AUTH',
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
export type ActivityResource = (typeof ACTIVITY_RESOURCES)[number];
export type ActivitySeverity = 'info' | 'notice' | 'sensitive';

export interface IActivityChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface IActivityLog extends Document {
  user: mongoose.Types.ObjectId;
  userName: string;
  userEmail: string;
  action: ActivityAction;
  resource: ActivityResource;
  resourceId?: string;
  /** Short human-readable summary, e.g. 'Deleted client "Acme Ltd"'. */
  summary?: string;
  /** Field-level diff for UPDATE events. */
  changes?: IActivityChange[];
  details?: Record<string, unknown>;
  severity: ActivitySeverity;
  businessId: mongoose.Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ActivityChangeSchema = new Schema<IActivityChange>(
  {
    field: { type: String, required: true },
    from: { type: Schema.Types.Mixed },
    to: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    userEmail: { type: String, required: true },
    action: { type: String, required: true, enum: ACTIVITY_ACTIONS },
    resource: { type: String, required: true, enum: ACTIVITY_RESOURCES },
    resourceId: { type: String },
    summary: { type: String },
    changes: { type: [ActivityChangeSchema], default: undefined },
    details: { type: Schema.Types.Mixed },
    severity: { type: String, enum: ['info', 'notice', 'sensitive'], default: 'info' },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// Back-compat: older clients read `timestamp`; it's just the creation time.
ActivityLogSchema.virtual('timestamp').get(function (this: IActivityLog) {
  return this.createdAt;
});

// Primary browse: newest-first within a business, with the common filters.
ActivityLogSchema.index({ businessId: 1, createdAt: -1 });
ActivityLogSchema.index({ businessId: 1, user: 1, createdAt: -1 });
ActivityLogSchema.index({ businessId: 1, action: 1, createdAt: -1 });
ActivityLogSchema.index({ businessId: 1, resource: 1, createdAt: -1 });
// Per-entity history ("show everything that happened to this invoice").
ActivityLogSchema.index({ businessId: 1, resource: 1, resourceId: 1, createdAt: -1 });

// Retention — drop entries past the configured age (default ~13 months).
const ttlDays = Number(process.env.ACTIVITY_LOG_TTL_DAYS) || 400;
ActivityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 });

export default mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);
