import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Invoice from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import '../models/Client.js'; // registers the Client schema so Invoice.populate('clientId') works

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

const sampleLineItems = [
  { description: 'Design work', quantity: 2, unitPrice: 100, total: 200 },
  { description: 'Hosting', quantity: 1, unitPrice: 50, total: 50 },
];

beforeAll(async () => {
  await connect();
}, 60000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('POST /api/invoices (create)', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/api/invoices').send({ lineItems: sampleLineItems });
    expect(res.status).toBe(401);
  });

  it('computes subtotal/tax/total from line items', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ lineItems: sampleLineItems, tax: 10, customClientName: 'Acme Co' });

    expect(res.status).toBe(201);
    expect(res.body.subtotal).toBe(250);
    expect(res.body.tax).toBe(10);
    expect(res.body.total).toBe(275); // 250 + 10%
    expect(res.body.status).toBe('draft');
    expect(res.body.invoiceNumber).toMatch(/^INV-/);
  });

  it('defaults dueDate to 7 days out when not provided', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const before = Date.now();
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ lineItems: sampleLineItems, customClientName: 'Acme Co' });

    expect(res.status).toBe(201);
    const dueDate = new Date(res.body.dueDate).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(dueDate).toBeGreaterThan(before + sevenDaysMs - 5000);
    expect(dueDate).toBeLessThan(before + sevenDaysMs + 60000);
  });

  it('recordAsIncome creates a linked income transaction and marks the invoice paid', async () => {
    const { token, business, admin } = await makeBusinessWithAdmin('A');
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ lineItems: sampleLineItems, customClientName: 'Acme Co', recordAsIncome: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paid');
    expect(res.body.transactionId).toBeTruthy();

    const tx = await Transaction.findById(res.body.transactionId);
    expect(tx).not.toBeNull();
    expect(tx!.amount).toBe(250);
    expect(tx!.type).toBe('income');
    expect(String(tx!.businessId)).toBe(String(business._id));
    expect(String(tx!.recordedBy)).toBe(String(admin._id));
  });

  it('does not record income unless recordAsIncome is explicitly set', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ lineItems: sampleLineItems, customClientName: 'Acme Co' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.transactionId).toBeFalsy();
    expect(await Transaction.countDocuments({})).toBe(0);
  });
});

describe('cross-business access control on /api/invoices (IDOR)', () => {
  const createInvoiceDirect = async (businessId: unknown) =>
    Invoice.create({
      businessId,
      invoiceNumber: `INV-TEST-${Date.now()}-${Math.random()}`,
      lineItems: sampleLineItems,
      subtotal: 250,
      tax: 0,
      total: 250,
      dueDate: new Date(),
    });

  it('blocks GET of another business\'s invoice', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const invoice = await createInvoiceDirect(b.business._id);

    const res = await request(app)
      .get(`/api/invoices/${invoice._id}`)
      .set('Authorization', `Bearer ${a.token}`);

    expect(res.status).toBe(404);
  });

  it('blocks status updates on another business\'s invoice', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const invoice = await createInvoiceDirect(b.business._id);

    const res = await request(app)
      .put(`/api/invoices/${invoice._id}/status`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ status: 'paid' });

    expect(res.status).toBe(404);
    const untouched = await Invoice.findById(invoice._id);
    expect(untouched?.status).toBe('draft');
  });

  it('only returns a business\'s own invoices from the list endpoint', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    await createInvoiceDirect(a.business._id);
    await createInvoiceDirect(a.business._id);
    await createInvoiceDirect(b.business._id);

    const res = await request(app)
      .get('/api/invoices')
      .set('Authorization', `Bearer ${a.token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });
});

describe('PUT /api/invoices/:id/status', () => {
  it('creates exactly one income transaction the first time an invoice is marked paid', async () => {
    const { token, business, admin } = await makeBusinessWithAdmin('A');
    const invoice = await Invoice.create({
      businessId: business._id,
      invoiceNumber: `INV-TEST-${Date.now()}`,
      lineItems: sampleLineItems,
      subtotal: 250,
      tax: 0,
      total: 250,
      dueDate: new Date(),
      status: 'sent',
    });

    const res1 = await request(app)
      .put(`/api/invoices/${invoice._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'paid' });

    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe('paid');
    expect(await Transaction.countDocuments({ businessId: business._id })).toBe(1);

    // Re-applying 'paid' should not create a second transaction (guarded by invoice.transactionId).
    const res2 = await request(app)
      .put(`/api/invoices/${invoice._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'paid' });

    expect(res2.status).toBe(200);
    expect(await Transaction.countDocuments({ businessId: business._id })).toBe(1);
    void admin;
  });
});

describe('GET /api/invoices/public/:id', () => {
  it('is reachable without an auth token', async () => {
    const { business } = await makeBusinessWithAdmin('A');
    const invoice = await Invoice.create({
      businessId: business._id,
      invoiceNumber: `INV-TEST-${Date.now()}`,
      lineItems: sampleLineItems,
      subtotal: 250,
      tax: 0,
      total: 250,
      dueDate: new Date(),
    });

    const res = await request(app).get(`/api/invoices/public/${invoice._id}`);
    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe(invoice.invoiceNumber);
  });

  it('returns 404 for a non-existent invoice', async () => {
    const res = await request(app).get('/api/invoices/public/000000000000000000000000');
    expect(res.status).toBe(404);
  });
});
