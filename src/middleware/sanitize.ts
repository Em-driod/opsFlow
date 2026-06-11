import type { Request, Response, NextFunction } from 'express';

const DANGEROUS = /[<>"']/g;

const sanitizeValue = (val: unknown): unknown => {
  if (typeof val === 'string') return val.replace(DANGEROUS, '');
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val !== null && typeof val === 'object') return sanitizeObject(val as Record<string, unknown>);
  return val;
};

const sanitizeObject = (obj: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = sanitizeValue(obj[key]);
  }
  return result;
};

export const sanitizeBody = (req: Request, _res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
};
