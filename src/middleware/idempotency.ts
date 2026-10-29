import type { Request, Response, NextFunction } from 'express';
import IdempotencyKey from '../models/IdempotencyKey.js';
import { isDuplicateKeyError } from '../utils/transaction.js';
import { logger } from '../utils/logger.js';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Opt-in idempotency for non-idempotent POSTs. Must run after `protect`.
 *
 * - No `Idempotency-Key` header: the request runs normally (backward compatible).
 * - First request with a key: claims it ("pending"), runs, stores the 2xx response.
 * - Repeat with the same key: replays the stored response with `Idempotent-Replayed: true`.
 * - Repeat while the first is still running: 409, so the client can retry shortly.
 * - Same key reused for a different endpoint: 422.
 * - Failed requests (non-2xx) release the key so the client can retry.
 */
export const idempotency = async (req: Request, res: Response, next: NextFunction) => {
  const key = req.header('Idempotency-Key');
  if (!key) return next();
  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({ message: 'Invalid Idempotency-Key header.' });
  }
  if (!req.user) return next();

  const businessId = req.user.businessId;
  const path = req.baseUrl + req.path;

  try {
    await IdempotencyKey.create({ businessId, key, method: req.method, path });
  } catch (e) {
    if (!isDuplicateKeyError(e)) return next(e);

    const existing = await IdempotencyKey.findOne({ businessId, key });
    if (!existing) {
      return res.status(409).json({ message: 'A request with this Idempotency-Key is being retried. Please try again.' });
    }
    if (existing.method !== req.method || existing.path !== path) {
      return res.status(422).json({ message: 'This Idempotency-Key was already used for a different request.' });
    }
    if (existing.state === 'pending') {
      return res.status(409).json({ message: 'This request is already being processed.' });
    }
    res.setHeader('Idempotent-Replayed', 'true');
    return res.status(existing.statusCode ?? 200).json(existing.responseBody ?? {});
  }

  // Capture the handler's JSON response so it can be replayed later.
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const statusCode = res.statusCode;
    const persist =
      statusCode >= 200 && statusCode < 300
        ? IdempotencyKey.updateOne(
            { businessId, key },
            { $set: { state: 'completed', statusCode, responseBody: JSON.parse(JSON.stringify(body ?? {})) } },
          )
        : IdempotencyKey.deleteOne({ businessId, key });
    // Respond only once the outcome is stored, so an immediate retry is
    // guaranteed to find a completed record rather than a pending one.
    persist
      .catch((err) => logger.error('[Idempotency] failed to persist key:', err))
      .finally(() => originalJson(body));
    return res;
  };

  // If the handler errors before responding, release the claim.
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      IdempotencyKey.deleteOne({ businessId, key, state: 'pending' }).catch(() => {});
    }
  });

  next();
};
