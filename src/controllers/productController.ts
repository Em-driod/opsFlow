import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as productService from '../services/productService.js';

export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const products = await productService.getProductsForBusiness(req.user.businessId);
  res.json(products);
});

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const product = await productService.createProductForBusiness(req.user.businessId, req.body);
  res.status(201).json(product);
});

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const product = await productService.updateProductForBusiness(req.params.id!, req.user.businessId, req.body);
  res.json(product);
});

export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await productService.deleteProductForBusiness(req.params.id!, req.user.businessId);
  res.json({ message: 'Product removed' });
});
