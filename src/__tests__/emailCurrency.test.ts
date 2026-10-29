import { resolveEmailCurrency, BASE_CURRENCY } from '../utils/currency.js';

describe('resolveEmailCurrency', () => {
  it('converts stored NGN amounts into the chosen currency, like the app does', () => {
    const usd = resolveEmailCurrency('USD');
    expect(usd.code).toBe('USD');
    expect(usd.convert(1467)).toBe(1);
    expect(usd.convert(6000)).toBeCloseTo(4.09, 2);

    const jpy = resolveEmailCurrency('JPY');
    expect(jpy.code).toBe('JPY');
    expect(jpy.convert(980)).toBe(100);
  });

  it('is case-insensitive and ignores surrounding spaces', () => {
    expect(resolveEmailCurrency(' usd ').code).toBe('USD');
  });

  it('keeps naira amounts unchanged', () => {
    const ngn = resolveEmailCurrency('NGN');
    expect(ngn.code).toBe(BASE_CURRENCY);
    expect(ngn.convert(6000)).toBe(6000);
  });

  it('falls back to naira for missing, unknown or non-string values instead of failing the send', () => {
    for (const bad of [undefined, null, '', 'XYZ', 123, {}, 'US$']) {
      const r = resolveEmailCurrency(bad);
      expect(r.code).toBe('NGN');
      expect(r.convert(6000)).toBe(6000);
    }
  });
});
