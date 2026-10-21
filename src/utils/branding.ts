import { AppError } from './AppError.js';

// Business logos are stored on the business profile as data URLs (uploaded from
// the app, resized client-side) or, for older data, a plain https URL.

// SVG is deliberately excluded: the logo is served back from our own origin
// (GET /api/businesses/:id/logo), and an SVG there could carry script.
const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_LOGO_BYTES = 600 * 1024;

export const parseLogoDataUrl = (value: string): { mime: string; buffer: Buffer } | null => {
  const m = DATA_URL_RE.exec(value);
  if (!m) return null;
  return { mime: m[1]!.toLowerCase().replace('image/jpg', 'image/jpeg'), buffer: Buffer.from(m[2]!, 'base64') };
};

// Returns the value to store: '' clears the logo; anything else must be a
// supported image under the size limit.
export const normaliseLogo = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new AppError('Logo must be an image', 400);
  if (/^https:\/\//i.test(value)) return value;
  const parsed = parseLogoDataUrl(value);
  if (!parsed) throw new AppError('Logo must be a PNG, JPG, WebP or GIF image', 400);
  if (parsed.buffer.length > MAX_LOGO_BYTES) throw new AppError('Logo is too large — please use an image under 600 KB', 400);
  return value;
};

// Absolute URL to the business logo for places that can't use a data URL —
// email clients (Gmail, Outlook) block inline data: images. Render sets
// RENDER_EXTERNAL_URL automatically; PUBLIC_API_URL overrides it. With neither
// configured, emails simply fall back to the business name.
export const logoUrlForEmail = (business: {
  _id: unknown;
  updatedAt?: Date;
  profile?: { logoImage?: string | undefined } | undefined;
} | null | undefined): string | undefined => {
  const logo = business?.profile?.logoImage;
  if (!business || !logo) return undefined;
  if (/^https:\/\//i.test(logo)) return logo;
  const base = (process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!base) return undefined;
  // Version by last update so a new logo isn't hidden behind a cached old one.
  const v = business.updatedAt ? new Date(business.updatedAt).getTime() : 0;
  return `${base}/api/businesses/${String(business._id)}/logo?v=${v}`;
};

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Brand colour for email headers; anything that isn't a plain #rrggbb falls
// back to the given default so a bad value can't break the email's styles.
export const emailBrandColor = (c: unknown, fallback = '#059669') =>
  typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback;

// Logo block for the coloured header of transactional emails.
export const emailLogoHtml = (logoUrl: string | undefined, businessName: string) =>
  logoUrl
    ? `<img src="${escAttr(logoUrl)}" alt="${escAttr(businessName)}" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:12px;object-fit:cover;background:#ffffff;margin:0 0 14px;border:0;" />`
    : '';
