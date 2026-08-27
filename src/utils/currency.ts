const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'CA$',
  AUD: 'A$',
  NGN: '₦',
};

/**
 * Resolve a currency code to its display symbol. Falls back to the raw code
 * (e.g. "CHF ") when we don't have a symbol mapped, so nothing silently
 * renders as US dollars.
 */
export const getCurrencySymbol = (currencyCode?: string | null): string => {
  if (!currencyCode) return '';
  return CURRENCY_SYMBOLS[currencyCode.toUpperCase()] || `${currencyCode.toUpperCase()} `;
};

/**
 * Format an amount in the given currency. `locale` only affects digit grouping;
 * the symbol is driven entirely by `currencyCode`.
 */
export const formatCurrency = (
  amount: number,
  currencyCode?: string | null,
  locale = 'en-NG',
): string => {
  const currency = (currencyCode || 'NGN').toUpperCase();
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Unknown ISO code — degrade gracefully instead of throwing.
    return `${getCurrencySymbol(currency)}${Math.round(amount).toLocaleString(locale)}`;
  }
};
