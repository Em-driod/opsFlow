// Every amount is stored in the app's base currency, NGN; the frontend converts
// from it for display. A business's own `currency` field defaults to USD and is
// not what the stored numbers are in, so emails must format with this instead.
export const BASE_CURRENCY = 'NGN';
