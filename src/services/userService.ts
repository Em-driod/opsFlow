import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import User, { type IUser } from '../models/User.js';
import Business from '../models/Business.js';
import { sendPasswordResetEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_LOGIN_CLIENT_ID);

export const generateToken = (id: mongoose.Types.ObjectId) =>
  jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '30d' });

const authResponse = async (user: IUser) => {
  const business = await Business.findById(user.businessId);
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    businessId: user.businessId,
    businessName: business?.name,
    token: generateToken(user._id as mongoose.Types.ObjectId),
  };
};

export const registerUser = async (params: {
  name: string;
  email: string;
  password: string;
  businessName: string;
}) => {
  const { name, email, password, businessName } = params;

  const userExists = await User.findOne({ email });
  if (userExists) throw new AppError('User with that email already exists', 400);
  if (!businessName) throw new AppError('Business name is required', 400);

  const newBusiness = new Business({ name: businessName });
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const newUser = new User({
    name,
    email,
    password: hashedPassword,
    role: 'admin',
    businessId: newBusiness._id,
  });
  newBusiness.owner = newUser._id;

  await newBusiness.save();
  await newUser.save();

  return {
    _id: newUser._id,
    name: newUser.name,
    email: newUser.email,
    role: newUser.role,
    businessId: newUser.businessId,
    businessName: newBusiness.name,
    token: generateToken(newUser._id as mongoose.Types.ObjectId),
  };
};

export const loginUser = async (email: string, password: string) => {
  const user = await User.findOne({ email });
  if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
    throw new AppError('Invalid email or password', 401);
  }
  return authResponse(user);
};

export const createStaffUser = async (
  requester: IUser,
  params: { name: string; email: string; password: string; role?: string; businessId: string },
) => {
  const { name, email, password, role, businessId } = params;

  if (!requester.businessId || requester.role !== 'admin') {
    throw new AppError('Not authorized - admin access required', 401);
  }
  if (requester.businessId.toString() !== businessId) {
    throw new AppError('Not authorized to create users for this business', 401);
  }

  const userExists = await User.findOne({ email });
  if (userExists) throw new AppError('User with that email already exists', 400);
  if (!password) throw new AppError('Password is required', 400);

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const newUser = new User({
    name,
    email,
    password: hashedPassword,
    role: role || 'staff',
    businessId: requester.businessId,
  });

  return newUser.save();
};

export const getUsersForBusiness = (businessId: mongoose.Types.ObjectId) =>
  User.find({ businessId }).select('-password');

export const getUserByIdForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const user = await User.findOne({ _id: id, businessId }).select('-password');
  if (!user) throw new AppError('User not found', 404);
  return user;
};

export const updateUserForBusiness = async (
  requester: IUser,
  targetId: string,
  updates: { name?: string; email?: string; role?: string; password?: string },
) => {
  const isSelf = targetId === (requester._id as mongoose.Types.ObjectId).toString();
  if (!isSelf && requester.role !== 'admin') {
    throw new AppError('Not authorized to update this user', 403);
  }

  const user = await User.findOne({ _id: targetId, businessId: requester.businessId });
  if (!user) throw new AppError('User not found', 404);

  user.name = updates.name || user.name;
  user.email = updates.email || user.email;
  if (updates.role && requester.role === 'admin' && !isSelf) {
    user.role = updates.role as 'admin' | 'staff';
  }
  if (updates.password) {
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(updates.password, salt);
  }

  return user.save();
};

export const deleteUserForBusiness = async (targetId: string, businessId: mongoose.Types.ObjectId) => {
  const user = await User.findOne({ _id: targetId, businessId });
  if (!user) throw new AppError('User not found', 404);
  await user.deleteOne();
  return user;
};

export const googleAuth = async (idToken: string) => {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_LOGIN_CLIENT_ID!,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new AppError('Invalid Google token.', 400);
  const { sub: googleId, email, name } = payload;

  let user = await User.findOne({ googleId });

  if (!user) {
    user = await User.findOne({ email });
    if (user) {
      user.googleId = googleId;
      user.authProvider = 'google';
      await user.save();
    }
  }

  if (!user) {
    return { needsBusinessName: true as const, googleIdToken: idToken, name, email };
  }

  return authResponse(user);
};

export const googleSignupComplete = async (idToken: string, businessName: string) => {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_LOGIN_CLIENT_ID!,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new AppError('Invalid Google token.', 400);
  const { sub: googleId, email, name } = payload;

  const existing = await User.findOne({ $or: [{ googleId }, { email }] });
  if (existing) throw new AppError('An account with that Google identity already exists.', 400);

  const newBusiness = new Business({ name: businessName });
  const newUser = new User({
    name: name || email,
    email,
    role: 'admin',
    authProvider: 'google',
    googleId,
    businessId: newBusiness._id,
  });
  newBusiness.owner = newUser._id;

  await newBusiness.save();
  await newUser.save();

  return {
    _id: newUser._id,
    name: newUser.name,
    email: newUser.email,
    role: newUser.role,
    businessId: newUser.businessId,
    businessName: newBusiness.name,
    token: generateToken(newUser._id as mongoose.Types.ObjectId),
  };
};

export const requestPasswordReset = async (email: string) => {
  const user = await User.findOne({ email: email?.toLowerCase().trim() }).select(
    '+passwordResetToken +passwordResetExpires',
  );
  if (!user) return; // Don't reveal whether the email exists

  const token = crypto.randomBytes(32).toString('hex');
  user.passwordResetToken = crypto.createHash('sha256').update(token).digest('hex');
  user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${token}`;
  await sendPasswordResetEmail({ email: user.email, name: user.name, resetUrl });
};

export const resetPasswordWithToken = async (token: string, password: string) => {
  if (!password || password.length < 8) {
    throw new AppError('Password must be at least 8 characters.', 400);
  }

  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    passwordResetToken: hashed,
    passwordResetExpires: { $gt: new Date() },
  }).select('+passwordResetToken +passwordResetExpires');

  if (!user) throw new AppError('Reset link is invalid or has expired.', 400);

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(password, salt);
  await user.updateOne({ $unset: { passwordResetToken: 1, passwordResetExpires: 1 } });
  await user.save();
};
