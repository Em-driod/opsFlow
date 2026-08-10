import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Transaction from '../models/Transaction.js';

const app = createTestApp();

const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const makeBusinessWithAdmin = async (label: string) => {
  const business = await Business.create({ name: `${label} Biz` });
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

beforeAll(async () => {
  await connect();
}, 60000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('GET /api/tax/metadata', () => {
  it('is reachable while authenticated and lists tax categories', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const res = await request(app).get('/api/tax/metadata').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.taxCategories)).toBe(true);
    expect(res.body.taxCategories.length).toBeGreaterThan(0);
    expect(res.body.taxCategories.some((c: { id: string }) => c.id === 'rent')).toBe(true);
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/tax/metadata');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/tax/pit/summary', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/tax/pit/summary');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid year', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const res = await request(app)
      .get('/api/tax/pit/summary')
      .query({ year: 'not-a-year' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('only computes tax from the requesting business\'s own transactions', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const year = new Date().getFullYear();
    const inYear = new Date(Date.UTC(year, 5, 1));

    await Transaction.create({
      businessId: a.business._id,
      amount: 500_000,
      type: 'income',
      category: 'Client payment',
      taxCategory: 'income_business',
      recordedBy: a.admin._id,
      date: inYear,
    });
    // A second business's income must not leak into A's tax summary.
    await Transaction.create({
      businessId: b.business._id,
      amount: 10_000_000,
      type: 'income',
      category: 'Client payment',
      taxCategory: 'income_business',
      recordedBy: b.admin._id,
      date: inYear,
    });

    const res = await request(app)
      .get('/api/tax/pit/summary')
      .query({ year })
      .set('Authorization', `Bearer ${a.token}`);

    expect(res.status).toBe(200);
    expect(res.body.grossIncome).toBe(500_000);
  });

  it('excludes transactions outside the requested tax year', async () => {
    const { business, admin, token } = await makeBusinessWithAdmin('A');
    const year = new Date().getFullYear();
    await Transaction.create({
      businessId: business._id,
      amount: 500_000,
      type: 'income',
      category: 'Client payment',
      taxCategory: 'income_business',
      recordedBy: admin._id,
      date: new Date(Date.UTC(year - 1, 5, 1)),
    });

    const res = await request(app)
      .get('/api/tax/pit/summary')
      .query({ year })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.grossIncome).toBe(0);
  });

  it('flags unclassified transactions instead of silently dropping them', async () => {
    const { business, admin, token } = await makeBusinessWithAdmin('A');
    const year = new Date().getFullYear();
    await Transaction.create({
      businessId: business._id,
      amount: 15_000,
      type: 'expense',
      category: 'xyzzy something with no keyword match',
      recordedBy: admin._id,
      date: new Date(Date.UTC(year, 3, 1)),
    });

    const res = await request(app)
      .get('/api/tax/pit/summary')
      .query({ year })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.unclassifiedCount).toBe(1);
    expect(res.body.unclassifiedAmount).toBe(15_000);
  });
});

describe('GET /api/tax/pit/export.csv', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/tax/pit/export.csv');
    expect(res.status).toBe(401);
  });

  it('returns a CSV attachment scoped to the requesting business', async () => {
    const { business, admin, token } = await makeBusinessWithAdmin('A');
    const year = new Date().getFullYear();
    await Transaction.create({
      businessId: business._id,
      amount: 250_000,
      type: 'income',
      category: 'Client payment',
      taxCategory: 'income_business',
      recordedBy: admin._id,
      date: new Date(Date.UTC(year, 2, 1)),
    });

    const res = await request(app)
      .get('/api/tax/pit/export.csv')
      .query({ year })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(`opsflow-pit-${year}.csv`);
    expect(res.text).toContain('Gross Income,250000.00');
  });
});
