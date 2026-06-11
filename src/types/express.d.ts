import mongoose from 'mongoose';
import { Request } from 'express';

export interface AuthUser {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  role: 'admin' | 'staff';
  name: string;
  email: string;
}

export interface AuthRequest extends Request {
  user: AuthUser;
}
