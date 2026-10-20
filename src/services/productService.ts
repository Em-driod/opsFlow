import mongoose from 'mongoose';
import Product from '../models/Product.js';
import { AppError } from '../utils/AppError.js';

// Owner-facing, so it opts in to the (normally hidden) cost price.
export const getProductsForBusiness = (businessId: mongoose.Types.ObjectId) =>
  Product.find({ businessId, isActive: true }).select('+costPrice').sort({ name: 1 });

// Blank / missing cost means "not set" (null), which the profit report treats
// differently from a genuine zero-cost item.
const normaliseCostPrice = (body: Record<string, unknown>) => {
  if (!('costPrice' in body)) return body;
  const raw = body.costPrice;
  if (raw === null || raw === undefined || raw === '') return { ...body, costPrice: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new AppError('Cost price must be zero or more', 400);
  return { ...body, costPrice: Math.round(n * 100) / 100 };
};

export const createProductForBusiness = async (businessId: mongoose.Types.ObjectId, body: Record<string, unknown>) => {
  try {
    return await Product.create({ ...normaliseCostPrice(body), businessId });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError((err as Error).message, 400);
  }
};

export const updateProductForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  updates: Record<string, unknown>,
) => {
  try {
    const { businessId: _ignored, ...safeUpdates } = normaliseCostPrice(updates);
    const product = await Product.findOneAndUpdate({ _id: id, businessId }, safeUpdates, {
      new: true,
      runValidators: true,
    }).select('+costPrice');
    if (!product) throw new AppError('Product not found', 404);
    return product;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError((err as Error).message, 400);
  }
};

export const deleteProductForBusiness = (id: string, businessId: mongoose.Types.ObjectId) =>
  Product.findOneAndUpdate({ _id: id, businessId }, { isActive: false });
