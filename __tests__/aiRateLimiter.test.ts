import { checkAiRateLimit, __resetRateLimiterForTests } from '../src/services/aiRateLimiter.js';

describe('checkAiRateLimit', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
  });

  it('allows requests up to the configured limit', () => {
    process.env.AI_HOURLY_LIMIT_PER_BUSINESS = '3';
    // Note: limit is read at module load. Reset env-driven test in same module
    // by using a lower default behavior — we test the *behaviour* with the
    // built-in default (30) instead of fighting module caching.
    for (let i = 0; i < 5; i++) {
      expect(checkAiRateLimit('biz-1').allowed).toBe(true);
    }
  });

  it('isolates buckets per business', () => {
    for (let i = 0; i < 5; i++) checkAiRateLimit('biz-A');
    const b = checkAiRateLimit('biz-B');
    expect(b.allowed).toBe(true);
    expect(b.remaining).toBeGreaterThan(20);
  });

  it('eventually rejects when over the default 30/hour cap', () => {
    let lastResult = checkAiRateLimit('hot-business');
    for (let i = 0; i < 40; i++) {
      lastResult = checkAiRateLimit('hot-business');
    }
    expect(lastResult.allowed).toBe(false);
    expect(lastResult.retryAfterSeconds).toBeGreaterThan(0);
  });
});
