import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import '../models/Client.js';

const app = createTestApp();

const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const makeBusinessWithAdmin = async (label: string) => {
  const business = await Business.create({ name: `${label} Biz`, currency: 'NGN' });
  const admin = await User.create({
    name: `${label} Admin`,
    email: `${label}-admin-${Date.now()}-${Math.random()}@example.com`,
    password: 'irrelevant-hash',
    role: 'admin',
    authProvider: 'local',
    businessId: business._id,
  });
  return { business, admin, token: signToken(admin._id) };
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// 1×1 transparent PNG
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const saveProfile = (token: string, businessId: unknown, body: Record<string, unknown>) =>
  request(app).put(`/api/businesses/${businessId}/profile`).set(auth(token)).send(body);

beforeAll(async () => {
  await connect();
}, 60000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('business profile save', () => {
  it('saves bank details and keeps them when another part of the profile is saved', async () => {
    const { business, token } = await makeBusinessWithAdmin('A');
    await saveProfile(token, business._id, { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A Biz' });
    await saveProfile(token, business._id, { tagline: 'Fresh food' });

    const stored = await Business.findById(business._id).lean();
    expect(stored!.profile).toMatchObject({ bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A Biz', tagline: 'Fresh food' });
  });

  it('keeps bank details off the public profile', async () => {
    const { business, token } = await makeBusinessWithAdmin('A');
    await saveProfile(token, business._id, { isPublic: true, accountNumber: '0123456789', logoImage: PNG_DATA_URL });
    const slug = (await Business.findById(business._id).lean())!.slug;

    const pub = await request(app).get(`/api/businesses/public/${slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.profile).not.toHaveProperty('accountNumber');
    expect(pub.body.profile.logoImage).toBe(PNG_DATA_URL);
  });

  it('accepts a PNG logo, rejects SVG, and clears with an empty string', async () => {
    const { business, token } = await makeBusinessWithAdmin('A');
    expect((await saveProfile(token, business._id, { logoImage: PNG_DATA_URL })).status).toBe(200);

    const svg = await saveProfile(token, business._id, { logoImage: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
    expect(svg.status).toBe(400);

    await saveProfile(token, business._id, { logoImage: '' });
    expect((await Business.findById(business._id).lean())!.profile?.logoImage).toBeFalsy();
  });
});

describe('branding endpoints', () => {
  it('returns name, logo, colour and whether bank details exist', async () => {
    const { business, token } = await makeBusinessWithAdmin('A');
    let res = await request(app).get('/api/businesses/me/branding').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'A Biz', logoImage: null, hasBankDetails: false });

    await saveProfile(token, business._id, { logoImage: PNG_DATA_URL, accentColor: '#059669', accountNumber: '0123456789' });
    res = await request(app).get('/api/businesses/me/branding').set(auth(token));
    expect(res.body).toMatchObject({ logoImage: PNG_DATA_URL, accentColor: '#059669', hasBankDetails: true });
  });

  it('supports GET /businesses/me', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const res = await request(app).get('/api/businesses/me').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('A Biz');
  });

  it('serves the logo as an image publicly, and 404s when there is none', async () => {
    const { business, token } = await makeBusinessWithAdmin('A');
    expect((await request(app).get(`/api/businesses/${business._id}/logo`)).status).toBe(404);

    await saveProfile(token, business._id, { logoImage: PNG_DATA_URL });
    const res = await request(app).get(`/api/businesses/${business._id}/logo`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('logo on shared documents', () => {
  it('is included on the public invoice and the public receipt', async () => {
    const { business, token } = await makeBusinessWithAdmin('A');
    await saveProfile(token, business._id, { logoImage: PNG_DATA_URL, email: 'hello@a.biz' });

    const inv = await request(app)
      .post('/api/invoices')
      .set(auth(token))
      .send({ customClientName: 'Ade', lineItems: [{ description: 'Work', quantity: 1, unitPrice: 100, total: 100 }] });
    const pubInv = await request(app).get(`/api/invoices/public/${inv.body._id}`);
    expect(pubInv.body.businessId.profile.logoImage).toBe(PNG_DATA_URL);

    const rc = await request(app)
      .post('/api/receipts')
      .set(auth(token))
      .send({ payerName: 'Ade', description: 'Work', items: [{ description: 'Work', amount: 100 }] });
    const pubRc = await request(app).get(`/api/receipts/public/${rc.body.publicToken}`);
    expect(pubRc.body.business).toMatchObject({ name: 'A Biz', logoImage: PNG_DATA_URL, email: 'hello@a.biz' });
  });
});
