import mongoose from 'mongoose';
import Business, { type IBusinessProfile } from '../models/Business.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import { AppError } from '../utils/AppError.js';
import { normaliseLogo, parseLogoDataUrl } from '../utils/branding.js';
import { isOrderingOpen } from './orderService.js';

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
    services, isPublic, coverImage, accentColor,
  } = updates;
  const logoImage = updates.logoImage !== undefined ? normaliseLogo(updates.logoImage) : undefined;

  // Bank details print on every invoice. Each field is only touched when sent,
  // so saving another part of the profile can't wipe them.
  const BANK_FIELDS = ['bankName', 'accountNumber', 'accountName', 'bankName2', 'accountNumber2', 'accountName2'] as const;
  const bank: Partial<Record<(typeof BANK_FIELDS)[number], string>> = {};
  for (const key of BANK_FIELDS) {
    const sent = updates[key];
    const value = sent !== undefined ? String(sent ?? '').trim().slice(0, 120) : business.profile?.[key];
    if (value) bank[key] = value;
  }

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
    ...bank,
  };

  await business.save();
  return business;
};

// Just what the app needs to brand its screens and documents — much lighter
// than GET /:id, which populates every user and client.
export const getBrandingForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const business = await Business.findById(businessId).select('name currency slug profile.logoImage profile.accentColor profile.isPublic profile.accountNumber profile.accountNumber2').lean();
  if (!business) throw new AppError('Business not found', 404);
  return {
    _id: business._id,
    name: business.name,
    currency: business.currency,
    slug: business.slug ?? null,
    isPublic: !!business.profile?.isPublic,
    logoImage: business.profile?.logoImage || null,
    accentColor: business.profile?.accentColor || '#6366f1',
    hasBankDetails: !!(business.profile?.accountNumber || business.profile?.accountNumber2),
  };
};

// Raw logo image for places that need a real URL (emails). Public by design:
// the logo already appears on every invoice and receipt link.
export const getLogoForBusiness = async (id: string) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Logo not found', 404);
  const business = await Business.findById(id).select('profile.logoImage').lean();
  const logo = business?.profile?.logoImage;
  if (!logo) throw new AppError('Logo not found', 404);
  if (/^https:\/\//i.test(logo)) return { redirect: logo };
  const parsed = parseLogoDataUrl(logo);
  if (!parsed) throw new AppError('Logo not found', 404);
  return parsed;
};

// The public page doesn't show payment details — those belong on invoices only.
const publicProfileFields = (profile: IBusinessProfile | undefined, services: unknown[]) => {
  const {
    bankName: _b1, accountNumber: _a1, accountName: _n1,
    bankName2: _b2, accountNumber2: _a2, accountName2: _n2,
    ...rest
  } = profile ?? ({} as IBusinessProfile);
  return { ...rest, services };
};

export const getPublicProfileBySlug = async (slug: string) => {
  const business = await Business.findOne({ slug });
  if (!business || !business.profile?.isPublic) throw new AppError('Profile not found', 404);

  // Fire-and-forget — a slow/failed view count shouldn't hold up or break the page load.
  Business.updateOne({ _id: business._id }, { $inc: { profileViews: 1 } }).catch(() => {});

  // Catalog items are the source of truth — a business only has to enter a
  // product once (in Catalog) for it to show up here, instead of re-typing it
  // into the profile's manual "services" list too. Catalog items are shown
  // first, with any hand-curated services (e.g. bundled packages) after.
  // $ne: false (not "true") so products saved before this field existed — which have
  // no showOnProfile in the document at all — still count as visible by default.
  const catalogItems = await Product.find({ businessId: business._id, isActive: true, showOnProfile: { $ne: false } })
    .sort({ name: 1 })
    .select('name description price image trackStock stock');

  const services = [
    ...catalogItems.map((p) => ({
      // Catalog items can be ordered online; hand-typed services can't.
      productId: String(p._id),
      name: p.name,
      description: p.description,
      price: p.price,
      image: p.image,
      inStock: p.trackStock ? p.stock : undefined,
    })),
    ...(business.profile?.services ?? []),
  ];

  return {
    name: business.name,
    slug: business.slug,
    currency: business.currency,
    profile: publicProfileFields(business.toObject().profile, services),
    ordering: { enabled: isOrderingOpen(business) },
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
