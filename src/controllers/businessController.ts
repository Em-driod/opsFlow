import type { Request, Response } from 'express';
import type mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import { audit } from '../utils/activityLogger.js';
import * as businessService from '../services/businessService.js';

// @desc    Create a new business
// @route   POST /api/businesses
// @access  Private
export const createBusiness = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const business = await businessService.createBusinessForOwner(req.user._id as mongoose.Types.ObjectId, req.body);
  res.status(201).json(business);
});

// @desc    Get business by ID
// @route   GET /api/businesses/:id
// @access  Private (own business only)
export const getBusinessById = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const business = await businessService.getBusinessById(req.params.id!, req.user.businessId);
  res.json(business);
});

// @desc    Update business
// @route   PUT /api/businesses/:id
// @access  Private/Admin (own business only)
export const updateBusiness = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const updatedBusiness = await businessService.updateBusiness(req.params.id!, req.user.businessId, req.body);
  audit({
    req,
    action: 'UPDATE',
    resource: 'BUSINESS',
    resourceId: req.params.id,
    summary: 'Updated business settings',
    details: {
      name: (req.body as { name?: string }).name,
      currency: (req.body as { currency?: string }).currency,
    },
  });
  res.json(updatedBusiness);
});

// @desc    Delete business
// @route   DELETE /api/businesses/:id
// @access  Private/Admin (own business only)
export const deleteBusiness = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await businessService.deleteBusiness(req.params.id!, req.user.businessId);
  res.json({ message: 'Business removed' });
});

// @desc    Update business public profile
// @route   PUT /api/businesses/:id/profile
// @access  Private/Admin (own business only)
export const updateBusinessProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const business = await businessService.updateBusinessProfile(req.params.id!, req.user.businessId, req.body);
  audit({
    req,
    action: 'UPDATE',
    resource: 'BUSINESS',
    resourceId: req.params.id,
    summary: 'Updated public profile / storefront',
    details: { fields: Object.keys(req.body || {}) },
  });
  res.json(business);
});

// @desc    Get public business profile by slug
// @route   GET /api/profile/:slug
// @access  Public
export const getPublicProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await businessService.getPublicProfileBySlug(req.params.slug!);
  res.json(profile);
});

// @desc    Add a user to a business
// @route   POST /api/businesses/:id/users
// @access  Private/Admin (own business only)
export const addUserToBusiness = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await businessService.addUserToBusiness(req.params.id!, req.user.businessId, req.body.userId);
  audit({
    req,
    action: 'UPDATE',
    resource: 'USER',
    resourceId: req.body.userId,
    summary: 'Linked a user to the business',
    severity: 'sensitive',
  });
  res.json({ message: 'User added to business' });
});
