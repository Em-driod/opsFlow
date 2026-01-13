import type { Request, Response } from "express";
import Business from "../models/Business.js";
import User from "../models/User.js";

// @desc    Create a new business
// @route   POST /api/businesses
// @access  Private
export const createBusiness = async (req: Request, res: Response) => {
    try {
        const { name, currency } = req.body;
        if (!req.user) {
            return res.status(401).json({ message: "Not authorized" });
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
        res.status(500).json({ message: "Server error", error });
    }
};

// @desc    Get business by ID
// @route   GET /api/businesses/:id
// @access  Private
export const getBusinessById = async (req: Request, res: Response) => {
    try {
        const business = await Business.findById(req.params.id)
            .populate("users", "-password")
            .populate("clients");
        if (business) {
            res.json(business);
        } else {
            res.status(404).json({ message: "Business not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error });
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
            res.status(404).json({ message: "Business not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error });
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
            res.json({ message: "Business removed" });
        } else {
            res.status(404).json({ message: "Business not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error });
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
            if (business.users.map(id => id.toString()).includes(userId)) {
                return res.status(400).json({ message: "User already in business" });
            }
            business.users.push(user._id);
            await business.save();

            // Link business to user
            user.businessId = business._id;
            await user.save();

            res.json({ message: "User added to business" });
        } else {
            res.status(404).json({ message: "Business or User not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error });
    }
}
