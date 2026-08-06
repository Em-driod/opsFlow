import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Payroll from '../models/Payroll.js';
import Transaction from '../models/Transaction.js';

const app = createTestApp();

const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const makeBusinessWithUser = async (label: string, role: 'admin' | 'staff' = 'admin') => {
  const business = await Business.create({ name: `${label} Biz` });
  const user = await User.create({
    name: `${label} ${role}`,
    email: `${label}-${role}-${Date.now()}-${Math.random()}@example.com`,
    password: 'irrelevant-hash',
    role,
    authProvider: 'local',
    businessId: business._id,
  });
  return { business, user, token: signToken(user._id) };
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

describe('POST /api/payrolls (create)', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/api/payrolls').send({ staffName: 'Jane', salary: 100000 });
    expect(res.status).toBe(401);
  });

  it('blocks non-admin staff from creating a payroll entry', async () => {
    const { token } = await makeBusinessWithUser('A', 'staff');
    const res = await request(app)
      .post('/api/payrolls')
      .set('Authorization', `Bearer ${token}`)
      .send({ staffName: 'Jane', salary: 100000 });
    expect(res.status).toBe(401);
  });

  it('lets an admin create a payroll entry with a derived payPeriod', async () => {
    const { token } = await makeBusinessWithUser('A', 'admin');
    const res = await request(app)
      .post('/api/payrolls')
      .set('Authorization', `Bearer ${token}`)
      .send({ staffName: 'Jane', salary: 150000, payday: '2026-03-15' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.payPeriod).toBe('2026-03');
  });
});

describe('cross-business access control on /api/payrolls (IDOR)', () => {
  it('blocks reading another business\'s payroll entry', async () => {
    const a = await makeBusinessWithUser('A');
    const b = await makeBusinessWithUser('B');
    const payroll = await Payroll.create({ businessId: b.business._id, staffName: 'Bob', salary: 100000, payday: new Date() });

    const res = await request(app)
      .get(`/api/payrolls/${payroll._id}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(404);
  });

  it('blocks updating another business\'s payroll entry', async () => {
    const a = await makeBusinessWithUser('A');
    const b = await makeBusinessWithUser('B');
    const payroll = await Payroll.create({ businessId: b.business._id, staffName: 'Bob', salary: 100000, payday: new Date() });

    const res = await request(app)
      .put(`/api/payrolls/${payroll._id}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ status: 'paid' });
    expect(res.status).toBe(404);
    const untouched = await Payroll.findById(payroll._id);
    expect(untouched?.status).toBe('pending');
  });

  it('only lists a business\'s own payroll entries', async () => {
    const a = await makeBusinessWithUser('A');
    const b = await makeBusinessWithUser('B');
    await Payroll.create({ businessId: a.business._id, staffName: 'Jane', salary: 100000, payday: new Date() });
    await Payroll.create({ businessId: b.business._id, staffName: 'Bob', salary: 100000, payday: new Date() });

    const res = await request(app).get('/api/payrolls').set('Authorization', `Bearer ${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].staffName).toBe('Jane');
  });
});

describe('PUT /api/payrolls/:id (mark paid)', () => {
  it('creates exactly one expense transaction the first time status becomes paid', async () => {
    const { token, business, user } = await makeBusinessWithUser('A');
    const payroll = await Payroll.create({ businessId: business._id, staffName: 'Jane', salary: 200000, payday: new Date() });

    const res1 = await request(app)
      .put(`/api/payrolls/${payroll._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'paid' });
    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe('paid');
    expect(await Transaction.countDocuments({ businessId: business._id })).toBe(1);

    const tx = await Transaction.findOne({ businessId: business._id });
    expect(tx!.type).toBe('expense');
    expect(tx!.amount).toBe(200000);
    expect(tx!.category).toBe('Payroll');
    void user;

    // Re-applying paid must not double-record the expense.
    const res2 = await request(app)
      .put(`/api/payrolls/${payroll._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'paid' });
    expect(res2.status).toBe(200);
    expect(await Transaction.countDocuments({ businessId: business._id })).toBe(1);
  });

  it('blocks non-admin staff from updating payroll status', async () => {
    const admin = await makeBusinessWithUser('A', 'admin');
    const staffBusiness = admin.business;
    const staff = await User.create({
      name: 'Staffer',
      email: `staff-${Date.now()}@example.com`,
      password: 'irrelevant-hash',
      role: 'staff',
      authProvider: 'local',
      businessId: staffBusiness._id,
    });
    const staffToken = signToken(staff._id);
    const payroll = await Payroll.create({ businessId: staffBusiness._id, staffName: 'Jane', salary: 100000, payday: new Date() });

    const res = await request(app)
      .put(`/api/payrolls/${payroll._id}`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ status: 'paid' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/payrolls/process', () => {
  it('marks all due pending payrolls as paid and records one expense each', async () => {
    const { token, business, user } = await makeBusinessWithUser('A');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await Payroll.create({ businessId: business._id, staffName: 'Due Staffer', salary: 100000, payday: yesterday, status: 'pending' });
    await Payroll.create({ businessId: business._id, staffName: 'Future Staffer', salary: 100000, payday: nextMonth, status: 'pending' });
    void user;

    const res = await request(app).post('/api/payrolls/process').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const due = await Payroll.findOne({ staffName: 'Due Staffer' });
    const future = await Payroll.findOne({ staffName: 'Future Staffer' });
    expect(due?.status).toBe('paid');
    expect(future?.status).toBe('pending');
    expect(await Transaction.countDocuments({ businessId: business._id })).toBe(1);
  });
});

describe('payslip generation and public access', () => {
  it('generates a payslip token only accessible via /api/payrolls/payslip/:token', async () => {
    const { token, business } = await makeBusinessWithUser('A');
    const payroll = await Payroll.create({
      businessId: business._id,
      staffName: 'Jane',
      salary: 200000,
      deductions: 10000,
      bonus: 5000,
      payday: new Date(),
    });

    const genRes = await request(app)
      .post(`/api/payrolls/${payroll._id}/payslip`)
      .set('Authorization', `Bearer ${token}`);
    expect(genRes.status).toBe(200);
    expect(genRes.body.token).toBeTruthy();

    const publicRes = await request(app).get(`/api/payrolls/payslip/${genRes.body.token}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.staffName).toBe('Jane');
    expect(publicRes.body.netPay).toBe(200000 - 10000 + 5000);
  });

  it('returns 404 for an unknown payslip token', async () => {
    const res = await request(app).get('/api/payrolls/payslip/does-not-exist');
    expect(res.status).toBe(404);
  });
});
