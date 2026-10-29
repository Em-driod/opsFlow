import { getExchangeRates } from '../services/currencyService.js';

// Every amount is stored in the app's base currency, NGN; the frontend converts
// from it for display. A business's own `currency` field defaults to USD and is
// not what the stored numbers are in, so never format stored amounts with it.
export const BASE_CURRENCY = 'NGN';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface EmailCurrency {
  // ISO code to format with.
  code: string;
  // Convert a stored (NGN) amount into `code`.
  convert: (ngn: number) => number;
}

// Resolves the currency a user picked in the app for something they email out.
// Unknown or missing codes fall back to NGN, so a bad value can't break a send.
export const resolveEmailCurrency = (requested?: unknown): EmailCurrency => {
  const code = typeof requested === 'string' ? requested.trim().toUpperCase() : '';
  const rate = code ? getExchangeRates()[BASE_CURRENCY.toLowerCase()]?.[code.toLowerCase()] : undefined;
  if (!code || code === BASE_CURRENCY || !(typeof rate === 'number' && rate > 0)) {
    return { code: BASE_CURRENCY, convert: (n) => n };
  }
  return { code, convert: (n) => round2(n * rate) };
};
