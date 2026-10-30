import crypto from 'crypto';

// Short codes customers type into a bank transfer's description so the payment
// can be matched automatically — e.g. "MR7K4Q2P" for an order, "IV3HX9QT" for
// an invoice. No 0/O/1/I, so they're easy to read aloud and type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const randomPaymentCode = (prefix: string, length = 6) =>
  prefix + Array.from(crypto.randomBytes(length), (b) => ALPHABET[b % ALPHABET.length]).join('');

export const uniquePaymentCode = async (prefix: string, taken: (code: string) => Promise<unknown>) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomPaymentCode(prefix);
    if (!(await taken(code))) return code;
  }
  throw new Error('Could not create a unique payment code');
};

// Upper-case letters and digits only — how bank narrations are compared.
export const normaliseForMatch = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
