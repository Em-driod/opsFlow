import mongoose, { Schema, Document } from 'mongoose';

export interface IProduct extends Document {
  businessId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  price: number;
  unit?: string;
  category?: string;
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
    unit: { type: String, default: 'unit' },
    category: { type: String },
    image: { type: String },
    isActive: { type: Boolean, default: true },
    trackStock: { type: Boolean, default: false },
    stock: { type: Number, default: 0 },
    showOnProfile: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export default mongoose.model<IProduct>('Product', ProductSchema);
