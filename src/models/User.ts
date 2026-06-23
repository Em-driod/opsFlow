import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  role: 'admin' | 'staff';
  email: string;
  password: string;
  businessId: mongoose.Types.ObjectId;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    role: { type: String, enum: ['admin', 'staff'], required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
  },
  { timestamps: true },
);

UserSchema.index({ passwordResetExpires: 1 }, { expireAfterSeconds: 0, sparse: true });

export default mongoose.model<IUser>('User', UserSchema);
