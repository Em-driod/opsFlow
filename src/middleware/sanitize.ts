import type { Request, Response, NextFunction } from 'express';

// Defence in depth only — the real XSS protection is output encoding (React
// escapes by default, email templates run every value through esc()).
// Only angle brackets are stripped, so no HTML tags can be stored. Quotes are
// kept: stripping them mangled legitimate data like "O'Brien" or "5\" pipe".
const DANGEROUS = /[<>]/g;

// The previous sanitiser also stripped quotes. Exported so login can recognise
// passwords that were hashed after that transformation (see userService).
export const LEGACY_DANGEROUS = /[<>"']/g;

// Secrets are hashed, never rendered, so they must reach the handler byte-for-byte.
const SKIP_KEYS = new Set(['password', 'currentPassword', 'newPassword', 'confirmPassword']);

const sanitizeValue = (val: unknown): unknown => {
  if (typeof val === 'string') return val.replace(DANGEROUS, '');
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val !== null && typeof val === 'object') return sanitizeObject(val as Record<string, unknown>);
  return val;
};

const sanitizeObject = (obj: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = SKIP_KEYS.has(key) ? obj[key] : sanitizeValue(obj[key]);
  }
  return result;
};

export const sanitizeBody = (req: Request, _res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
};
