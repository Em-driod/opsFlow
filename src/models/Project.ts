import mongoose, { Schema, Document } from 'mongoose';

export interface IProject extends Document {
  businessId: mongoose.Types.ObjectId;
  clientId?: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  status: 'planning' | 'active' | 'completed' | 'on_hold';
  budget?: number;
  teamMembers: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema: Schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  clientId: { type: Schema.Types.ObjectId, ref: 'Client' },
  name: { type: String, required: true },
  description: { type: String },
  status: { type: String, enum: ['planning', 'active', 'completed', 'on_hold'], default: 'active' },
  budget: { type: Number, default: 0 },
  teamMembers: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, {
  timestamps: true
});

export default mongoose.model<IProject>('Project', ProjectSchema);
