import mongoose, { Schema, Document } from 'mongoose';

export interface IProduct extends Document {
  businessId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  price: number;
  costPrice?: number | null;
  unit?: string;
  category?: string;
  subcategory?: string;
  image?: string;
  isActive: boolean;
  trackStock: boolean;
  stock: number;
  showOnProfile: boolean;
}

const ProductSchema: Schema = new Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    name: { type: String, required: true },
    description: { type: String },
    price: { type: Number, required: true, default: 0 },
    // What one unit costs the business. Hidden by default so it can never reach
    // the public profile/storefront — owner-facing queries opt in with +costPrice.
    // null = not set yet (distinct from a genuine zero-cost item).
    costPrice: { type: Number, min: 0, default: null, select: false },
    unit: { type: String, default: 'unit' },
    category: { type: String, trim: true, maxlength: 60 },
    // Second level under category, e.g. Drinks → Soft drinks. Optional.
    subcategory: { type: String, trim: true, maxlength: 60 },
    image: { type: String },
    isActive: { type: Boolean, default: true },
    trackStock: { type: Boolean, default: false },
    stock: { type: Number, default: 0 },
    showOnProfile: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export default mongoose.model<IProduct>('Product', ProductSchema);
