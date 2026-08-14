import mongoose from 'mongoose';
import Business, { type IBusinessProfile } from '../models/Business.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import { AppError } from '../utils/AppError.js';

export const createBusinessForOwner = async (
  ownerId: mongoose.Types.ObjectId,
  params: { name: string; currency?: string },
) => {
  const business = await Business.create({
    name: params.name,
    owner: ownerId,
    users: [ownerId],
    currency: params.currency,
  });

  await User.findByIdAndUpdate(ownerId, { businessId: business._id });

  return business;
};

const assertOwnBusiness = (businessId: mongoose.Types.ObjectId, id: string) => {
  if (businessId.toString() !== id) {
    throw new AppError('Business not found', 404);
  }
};

export const getBusinessById = async (id: string, requesterBusinessId: mongoose.Types.ObjectId) => {
  assertOwnBusiness(requesterBusinessId, id);
  const business = await Business.findById(id).populate('users', '-password').populate('clients');
  if (!business) throw new AppError('Business not found', 404);
  return business;
};

export const updateBusiness = async (
  id: string,
  requesterBusinessId: mongoose.Types.ObjectId,
  updates: { name?: string; currency?: string },
) => {
  assertOwnBusiness(requesterBusinessId, id);
  const business = await Business.findById(id);
  if (!business) throw new AppError('Business not found', 404);

  business.name = updates.name || business.name;
  business.currency = updates.currency || business.currency;
  return business.save();
};

export const deleteBusiness = async (id: string, requesterBusinessId: mongoose.Types.ObjectId) => {
  assertOwnBusiness(requesterBusinessId, id);
  const business = await Business.findById(id);
  if (!business) throw new AppError('Business not found', 404);
  await business.deleteOne();
};

export const updateBusinessProfile = async (
  id: string,
  requesterBusinessId: mongoose.Types.ObjectId,
  updates: Partial<IBusinessProfile>,
) => {
  assertOwnBusiness(requesterBusinessId, id);
  const business = await Business.findById(id);
  if (!business) throw new AppError('Business not found', 404);

  const {
    tagline, description, whatsapp, email, website, instagram, location,
    services, isPublic, coverImage, logoImage, accentColor,
  } = updates;

  if (!business.slug) {
    const base = business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let slug = base;
    let i = 1;
    while (await Business.findOne({ slug, _id: { $ne: business._id } })) {
      slug = `${base}-${i++}`;
    }
    business.slug = slug;
  }

  const nextTagline = tagline ?? business.profile?.tagline;
  const nextDescription = description ?? business.profile?.description;
  const nextWhatsapp = whatsapp ?? business.profile?.whatsapp;
  const nextEmail = email ?? business.profile?.email;
  const nextWebsite = website ?? business.profile?.website;
  const nextInstagram = instagram ?? business.profile?.instagram;
  const nextLocation = location ?? business.profile?.location;
  const nextCoverImage = coverImage !== undefined ? coverImage : business.profile?.coverImage;
  const nextLogoImage = logoImage !== undefined ? logoImage : business.profile?.logoImage;

  business.profile = {
    ...(nextTagline !== undefined ? { tagline: nextTagline } : {}),
    ...(nextDescription !== undefined ? { description: nextDescription } : {}),
    ...(nextWhatsapp !== undefined ? { whatsapp: nextWhatsapp } : {}),
    ...(nextEmail !== undefined ? { email: nextEmail } : {}),
    ...(nextWebsite !== undefined ? { website: nextWebsite } : {}),
    ...(nextInstagram !== undefined ? { instagram: nextInstagram } : {}),
    ...(nextLocation !== undefined ? { location: nextLocation } : {}),
    services: services ?? business.profile?.services ?? [],
    isPublic: isPublic !== undefined ? isPublic : (business.profile?.isPublic ?? false),
    ...(nextCoverImage !== undefined ? { coverImage: nextCoverImage } : {}),
    ...(nextLogoImage !== undefined ? { logoImage: nextLogoImage } : {}),
    accentColor: accentColor ?? business.profile?.accentColor ?? '#6366f1',
  };

  await business.save();
  return business;
};

export const getPublicProfileBySlug = async (slug: string) => {
  const business = await Business.findOne({ slug });
  if (!business || !business.profile?.isPublic) throw new AppError('Profile not found', 404);

  // Catalog items are the source of truth — a business only has to enter a
  // product once (in Catalog) for it to show up here, instead of re-typing it
  // into the profile's manual "services" list too. Catalog items are shown
  // first, with any hand-curated services (e.g. bundled packages) after.
  const catalogItems = await Product.find({ businessId: business._id, isActive: true, showOnProfile: true })
    .sort({ name: 1 })
    .select('name description price image');

  const services = [
    ...catalogItems.map((p) => ({ name: p.name, description: p.description, price: p.price, image: p.image })),
    ...(business.profile?.services ?? []),
  ];

  return {
    name: business.name,
    slug: business.slug,
    currency: business.currency,
    profile: { ...business.profile, services },
  };
};

export const addUserToBusiness = async (businessId: string, requesterBusinessId: mongoose.Types.ObjectId, userId: string) => {
  assertOwnBusiness(requesterBusinessId, businessId);
  const business = await Business.findById(businessId);
  const user = await User.findById(userId);
  if (!business || !user) throw new AppError('Business or User not found', 404);

  if (business.users.map((id) => id.toString()).includes(userId)) {
    throw new AppError('User already in business', 400);
  }

  business.users.push(user._id as mongoose.Types.ObjectId);
  await business.save();

  user.businessId = business._id as mongoose.Types.ObjectId;
  await user.save();
};
