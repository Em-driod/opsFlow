import mongoose from 'mongoose';
import Product from '../models/Product.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex } from '../utils/regex.js';

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

// Tidies category/sub-category text ("  drinks " → "drinks") and drops a
// sub-category that has no category above it.
const cleanLabel = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 60) : '');
const normaliseCategories = (body: Record<string, unknown>) => {
  if (!('category' in body) && !('subcategory' in body)) return body;
  const next = { ...body };
  if ('category' in body) next.category = cleanLabel(body.category);
  if ('subcategory' in body) next.subcategory = cleanLabel(body.subcategory);
  if ('category' in body && !next.category) next.subcategory = '';
  return next;
};

// Renames a category (or one sub-category inside it) on every product at once.
export const renameCategoryForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { category?: unknown; subcategory?: unknown; newName?: unknown },
) => {
  const category = cleanLabel(params.category);
  const subcategory = cleanLabel(params.subcategory);
  const newName = cleanLabel(params.newName);
  if (!category) throw new AppError('Choose a category', 400);
  if (!newName) throw new AppError('Enter the new name', 400);

  const rx = (s: string) => new RegExp(`^${escapeRegex(s)}$`, 'i');
  const filter: Record<string, unknown> = { businessId, category: rx(category) };
  if (subcategory) filter.subcategory = rx(subcategory);
  const res = await Product.updateMany(filter, { $set: subcategory ? { subcategory: newName } : { category: newName } });
  return { updated: res.modifiedCount };
};

export const createProductForBusiness = async (businessId: mongoose.Types.ObjectId, body: Record<string, unknown>) => {
  try {
    return await Product.create({ ...normaliseCategories(normaliseCostPrice(body)), businessId });
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
    const { businessId: _ignored, ...safeUpdates } = normaliseCategories(normaliseCostPrice(updates));
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
