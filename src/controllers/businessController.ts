import type { Request, Response } from 'express';
import Business from '../models/Business.js';
import User from '../models/User.js';

// @desc    Create a new business
// @route   POST /api/businesses
// @access  Private
export const createBusiness = async (req: Request, res: Response) => {
  try {
    const { name, currency } = req.body;
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized' });
    }
    const owner = req.user._id;

    const business = await Business.create({
      name,
      owner,
      users: [owner],
      currency,
    });

    // Link business to user
    await User.findByIdAndUpdate(req.user._id, { businessId: business._id });

    res.status(201).json(business);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};

// @desc    Get business by ID
// @route   GET /api/businesses/:id
// @access  Private
export const getBusinessById = async (req: Request, res: Response) => {
  try {
    const business = await Business.findById(req.params.id)
      .populate('users', '-password')
      .populate('clients');
    if (business) {
      res.json(business);
    } else {
      res.status(404).json({ message: 'Business not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};

// @desc    Update business
// @route   PUT /api/businesses/:id
// @access  Private
export const updateBusiness = async (req: Request, res: Response) => {
  try {
    const business = await Business.findById(req.params.id);
    if (business) {
      business.name = req.body.name || business.name;
      business.currency = req.body.currency || business.currency;
      const updatedBusiness = await business.save();
      res.json(updatedBusiness);
    } else {
      res.status(404).json({ message: 'Business not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};

// @desc    Delete business
// @route   DELETE /api/businesses/:id
// @access  Private
export const deleteBusiness = async (req: Request, res: Response) => {
  try {
    const business = await Business.findById(req.params.id);
    if (business) {
      await business.deleteOne();
      res.json({ message: 'Business removed' });
    } else {
      res.status(404).json({ message: 'Business not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};

// @desc    Update business public profile
// @route   PUT /api/businesses/:id/profile
// @access  Private
export const updateBusinessProfile = async (req: Request, res: Response) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const { tagline, description, whatsapp, email, website, instagram, location, services, isPublic } = req.body;

    // Generate slug from business name if not set
    if (!business.slug) {
      const base = business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let slug = base;
      let i = 1;
      while (await Business.findOne({ slug, _id: { $ne: business._id } })) {
        slug = `${base}-${i++}`;
      }
      business.slug = slug;
    }

    business.profile = {
      tagline: tagline ?? business.profile?.tagline,
      description: description ?? business.profile?.description,
      whatsapp: whatsapp ?? business.profile?.whatsapp,
      email: email ?? business.profile?.email,
      website: website ?? business.profile?.website,
      instagram: instagram ?? business.profile?.instagram,
      location: location ?? business.profile?.location,
      services: services ?? business.profile?.services ?? [],
      isPublic: isPublic !== undefined ? isPublic : (business.profile?.isPublic ?? false),
    };

    await business.save();
    res.json(business);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};

// @desc    Get public business profile by slug
// @route   GET /api/profile/:slug
// @access  Public
export const getPublicProfile = async (req: Request, res: Response) => {
  try {
    const business = await Business.findOne({ slug: req.params.slug });
    if (!business || !business.profile?.isPublic) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    res.json({
      name: business.name,
      slug: business.slug,
      currency: business.currency,
      profile: business.profile,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};

// @desc    Add a user to a business
// @route   POST /api/businesses/:id/users
// @access  Private
export const addUserToBusiness = async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    const business = await Business.findById(req.params.id);
    const user = await User.findById(userId);

    if (business && user) {
      if (business.users.map((id) => id.toString()).includes(userId)) {
        return res.status(400).json({ message: 'User already in business' });
      }
      business.users.push(user._id);
      await business.save();

      // Link business to user
      user.businessId = business._id;
      await user.save();

      res.json({ message: 'User added to business' });
    } else {
      res.status(404).json({ message: 'Business or User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};
