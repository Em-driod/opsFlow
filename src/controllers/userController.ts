import type { Request, Response } from 'express';
import { logActivity } from '../utils/activityLogger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as userService from '../services/userService.js';

// @desc    Register a new user and business
// @route   POST /api/users/register
// @access  Public
export const registerUser = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password, businessName } = req.body;
  const result = await userService.registerUser({ name, email, password, businessName });
  res.status(201).json(result);
});

// @desc    Auth user & get token
// @route   POST /api/users/login
// @access  Public
export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const result = await userService.loginUser(email, password);
  res.json(result);
});

// @desc    Create a staff user for existing business
// @route   POST /api/users/staff
// @access  Private/Admin
export const createStaffUser = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { name, email, password, role, businessId } = req.body;
  const savedUser = await userService.createStaffUser(req.user, { name, email, password, role, businessId });

  await logActivity({
    req,
    action: 'CREATE',
    resource: 'USER',
    resourceId: savedUser._id.toString(),
    details: { createdUserName: name, createdUserEmail: email, createdUserRole: role || 'staff' },
  });

  res.status(201).json({
    _id: savedUser._id,
    name: savedUser.name,
    email: savedUser.email,
    role: savedUser.role,
    businessId: savedUser.businessId,
  });
});

// @desc    Get all users for a business
// @route   GET /api/users
// @access  Private/Admin
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const users = await userService.getUsersForBusiness(req.user.businessId);
  res.json(users);
});

// @desc    Get user by ID
// @route   GET /api/users/:id
// @access  Private (same business only)
export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const user = await userService.getUserByIdForBusiness(req.params.id!, req.user.businessId);
  res.json(user);
});

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (self, or admin within same business). Only admins may change role.
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const updatedUser = await userService.updateUserForBusiness(req.user, req.params.id!, req.body);

  await logActivity({
    req,
    action: 'UPDATE',
    resource: 'USER',
    resourceId: updatedUser._id.toString(),
    details: {
      updatedFields: {
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        passwordChanged: !!req.body.password,
      },
    },
  });

  res.json({
    _id: updatedUser._id,
    name: updatedUser.name,
    email: updatedUser.email,
    role: updatedUser.role,
    businessId: updatedUser.businessId,
  });
});

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private/Admin (same business only)
export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const user = await userService.deleteUserForBusiness(req.params.id!, req.user.businessId);

  await logActivity({
    req,
    action: 'DELETE',
    resource: 'USER',
    resourceId: user._id.toString(),
    details: { deletedUserName: user.name, deletedUserEmail: user.email, deletedUserRole: user.role },
  });

  res.json({ message: 'User removed' });
});

// @desc    Sign in / sign up with Google
// @route   POST /api/users/google
// @access  Public
export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
  const { idToken } = req.body as { idToken: string };
  try {
    const result = await userService.googleAuth(idToken);
    res.json(result);
  } catch (error) {
    console.error(error);
    throw new AppError('Google authentication failed.', 401);
  }
});

// @desc    Complete Google sign-up by creating a business for a brand-new user
// @route   POST /api/users/google/complete
// @access  Public
export const googleSignupComplete = asyncHandler(async (req: Request, res: Response) => {
  const { idToken, businessName } = req.body as { idToken: string; businessName: string };
  const result = await userService.googleSignupComplete(idToken, businessName);
  res.status(201).json(result);
});

// @desc    Request a password reset email
// @route   POST /api/users/forgot-password
// @access  Public
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  try {
    await userService.requestPasswordReset(email);
  } catch (error) {
    console.error(error);
    // Fall through — always return 200 so the response never reveals whether the email exists.
  }
  res.status(200).json({ message: 'If that email is registered, a reset link has been sent.' });
});

// @desc    Reset password using a reset token
// @route   POST /api/users/reset-password/:token
// @access  Public
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.params as { token: string };
  const { password } = req.body as { password: string };
  await userService.resetPasswordWithToken(token, password);
  res.status(200).json({ message: 'Password reset successful. You can now sign in.' });
});
