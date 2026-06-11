import type { Request, Response } from 'express';
import Product from '../models/Product.js';

export const getProducts = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const products = await Product.find({ businessId, isActive: true }).sort({ name: 1 });
    res.json(products);
  } catch {
    res.status(500).json({ message: 'Failed to fetch products' });
  }
};

export const createProduct = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const product = await Product.create({ ...req.body, businessId });
    res.status(201).json(product);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

export const updateProduct = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, businessId },
      req.body,
      { new: true },
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    await Product.findOneAndUpdate({ _id: req.params.id, businessId }, { isActive: false });
    res.json({ message: 'Product removed' });
  } catch {
    res.status(500).json({ message: 'Failed to delete product' });
  }
};
