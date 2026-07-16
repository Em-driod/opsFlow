import mongoose from 'mongoose';
import Product from '../models/Product.js';
import { AppError } from '../utils/AppError.js';

export const getProductsForBusiness = (businessId: mongoose.Types.ObjectId) =>
  Product.find({ businessId, isActive: true }).sort({ name: 1 });

export const createProductForBusiness = async (businessId: mongoose.Types.ObjectId, body: Record<string, unknown>) => {
  try {
    return await Product.create({ ...body, businessId });
  } catch (err) {
    throw new AppError((err as Error).message, 400);
  }
};

export const updateProductForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  updates: Record<string, unknown>,
) => {
  try {
    const product = await Product.findOneAndUpdate({ _id: id, businessId }, updates, { new: true });
    if (!product) throw new AppError('Product not found', 404);
    return product;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError((err as Error).message, 400);
  }
};

export const deleteProductForBusiness = (id: string, businessId: mongoose.Types.ObjectId) =>
  Product.findOneAndUpdate({ _id: id, businessId }, { isActive: false });
