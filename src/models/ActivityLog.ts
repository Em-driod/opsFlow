import mongoose, { Schema, Document } from 'mongoose';

export interface IActivityLog extends Document {
  user: mongoose.Types.ObjectId;
  userName: string;
  userEmail: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: any;
  businessId: mongoose.Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
}

const ActivityLogSchema: Schema = new Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    userEmail: { type: String, required: true },
    action: { 
      type: String, 
      required: true,
      enum: ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'VIEW']
    },
    resource: { 
      type: String, 
      required: true,
      enum: ['USER', 'CLIENT', 'TRANSACTION', 'INVOICE', 'BUSINESS', 'PAYROLL']
    },
    resourceId: { type: mongoose.Schema.Types.ObjectId },
    details: { type: Schema.Types.Mixed }, // Store additional details
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  { 
    timestamps: true,
    // Add index for better query performance
    index: { businessId: 1, timestamp: -1 }
  }
);

export default mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);
