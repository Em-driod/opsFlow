/**
 * In-memory rate limiter for AI calls.
 *
 * Why this exists: Gemini calls cost money per token. Without a guard, a single
 * curious user can hammer /intelligence/parse and burn more in tokens than they
 * pay us. This limiter is a per-business sliding window.
 *
 * For production at scale, swap the in-memory map for Redis so the limit holds
 * across multiple server instances. As a single-instance default it's fine and
 * adds zero new infrastructure.
 */

const HOURLY_LIMIT = Number(process.env.AI_HOURLY_LIMIT_PER_BUSINESS ?? 30);
const WINDOW_MS = 60 * 60 * 1000;

const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export const checkAiRateLimit = (businessId: string): RateLimitResult => {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const existing = buckets.get(businessId) || [];
  const recent = existing.filter((t) => t > cutoff);

  if (recent.length >= HOURLY_LIMIT) {
    const oldest = recent[0]!;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    buckets.set(businessId, recent);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  recent.push(now);
  buckets.set(businessId, recent);
  return {
    allowed: true,
    remaining: HOURLY_LIMIT - recent.length,
    retryAfterSeconds: 0,
  };
};

// Exposed only so tests can reset state between cases.
export const __resetRateLimiterForTests = () => {
  buckets.clear();
};
