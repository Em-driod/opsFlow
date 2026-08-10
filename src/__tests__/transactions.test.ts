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

describe('POST /api/transactions — date persistence', () => {
  it('stores the user-supplied date rather than only createdAt', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const res = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 5000, type: 'income', category: 'Sales', description: 'Backdated sale', date: '2025-01-15' });

    expect(res.status).toBe(201);
    expect(new Date(res.body.date).toISOString().slice(0, 10)).toBe('2025-01-15');
  });

  it('defaults to today when no date is supplied', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const before = Date.now();
    const res = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 5000, type: 'income', category: 'Sales', description: 'Undated sale' });

    expect(res.status).toBe(201);
    const stored = new Date(res.body.date).getTime();
    expect(stored).toBeGreaterThanOrEqual(before - 5000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 5000);
  });
});

describe('PUT /api/transactions/:id — date persistence', () => {
  it('lets a transaction be re-dated after creation', async () => {
    const { token, business, admin } = await makeBusinessWithAdmin('A');
    const tx = await Transaction.create({
      businessId: business._id,
      amount: 1000,
      type: 'expense',
      category: 'Office',
      recordedBy: admin._id,
      date: new Date('2025-06-01'),
    });

    const res = await request(app)
      .put(`/api/transactions/${tx._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2025-07-20' });

    expect(res.status).toBe(200);
    expect(new Date(res.body.date).toISOString().slice(0, 10)).toBe('2025-07-20');
  });
});

describe('GET /api/reporting/financial-summary — filters by date, not createdAt', () => {
  it('includes a transaction whose date falls in range even if created outside it', async () => {
    const { token, business, admin } = await makeBusinessWithAdmin('A');
    // Record inserted "now" but the transaction itself happened in March.
    await Transaction.create({
      businessId: business._id,
      amount: 20000,
      type: 'income',
      category: 'Sales',
      recordedBy: admin._id,
      date: new Date('2026-03-15'),
    });

    const res = await request(app)
      .get('/api/reporting/financial-summary')
      .query({ startDate: '2026-03-01', endDate: '2026-03-31' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0].totalIncome).toBe(20000);
  });

  it('excludes a transaction whose date falls outside the range', async () => {
    const { token, business, admin } = await makeBusinessWithAdmin('A');
    await Transaction.create({
      businessId: business._id,
      amount: 20000,
      type: 'income',
      category: 'Sales',
      recordedBy: admin._id,
      date: new Date('2026-01-01'),
    });

    const res = await request(app)
      .get('/api/reporting/financial-summary')
      .query({ startDate: '2026-03-01', endDate: '2026-03-31' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0].totalIncome).toBe(0);
  });

  it('groups by client when groupBy=client is passed', async () => {
    const { token, business, admin } = await makeBusinessWithAdmin('A');
    await Transaction.create({
      businessId: business._id,
      amount: 15000,
      type: 'income',
      category: 'Sales',
      recordedBy: admin._id,
      date: new Date('2026-03-10'),
    });

    const res = await request(app)
      .get('/api/reporting/financial-summary')
      .query({ startDate: '2026-03-01', endDate: '2026-03-31', groupBy: 'client' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].totalIncome).toBe(15000);
  });
});
