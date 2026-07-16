interface RatesCache {
  rates: Record<string, Record<string, number>>;
  timestamp: number;
}

let ratesCache: RatesCache | null = null;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

/**
 * Hardcoded exchange rates with NGN as the base currency.
 * These rates are approximate and for demonstration purposes.
 */
const HARDCODED_RATES: Record<string, Record<string, number>> = {
  ngn: {
    usd: 1 / 1467,
    eur: 1 / 1600,
    gbp: 1 / 1850,
    jpy: 1 / 9.8,
    cad: 1 / 1080,
    aud: 1 / 970,
    ngn: 1,
  },
};

export const getExchangeRates = () => {
  if (ratesCache && Date.now() - ratesCache.timestamp < CACHE_DURATION) {
    return ratesCache.rates;
  }

  ratesCache = { rates: HARDCODED_RATES, timestamp: Date.now() };
  return HARDCODED_RATES;
};
