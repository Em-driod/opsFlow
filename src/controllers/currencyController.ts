import type { Request, Response } from 'express';

// In-memory cache for exchange rates
let ratesCache: { rates: any; timestamp: number } | null = null;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

/**
 * @desc    Get latest exchange rates (hardcoded)
 * @route   GET /api/currency/rates
 * @access  Private
 */
export const getRates = async (req: Request, res: Response) => {
  // Hardcoded exchange rates with NGN as the base currency.
  // These rates are approximate and for demonstration purposes.
  const hardcodedRates = {
    ngn: {
      // NGN as the base currency
      usd: 1 / 1467, // 1 USD = 1467 NGN
      eur: 1 / 1600, // 1 EUR = 1600 NGN
      gbp: 1 / 1850, // 1 GBP = 1850 NGN
      jpy: 1 / 9.8, // 1 JPY = 9.8 NGN
      cad: 1 / 1080, // 1 CAD = 1080 NGN
      aud: 1 / 970, // 1 AUD = 970 NGN
      ngn: 1, // 1 NGN = 1 NGN
    },
  };

  // Check cache first
  if (ratesCache && Date.now() - ratesCache.timestamp < CACHE_DURATION) {
    return res.status(200).json(ratesCache.rates);
  }

  // Since rates are hardcoded, we just use them directly
  ratesCache = {
    rates: hardcodedRates,
    timestamp: Date.now(),
  };

  res.status(200).json(hardcodedRates);
};
