import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as currencyService from '../services/currencyService.js';

/**
 * @desc    Get latest exchange rates (hardcoded)
 * @route   GET /api/currency/rates
 * @access  Private
 */
export const getRates = asyncHandler(async (_req: Request, res: Response) => {
  const rates = currencyService.getExchangeRates();
  res.status(200).json(rates);
});
