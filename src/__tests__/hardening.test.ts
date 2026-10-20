import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Invoice from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import RecurringInvoice from '../models/RecurringInvoice.js';
import Client from '../models/Client.js';
import '../models/IdempotencyKey.js';
import { generateDueRecurringInvoices } from '../services/recurringInvoiceService.js';

const PAYSTACK_SECRET = 'sk_test_hardening_suite';
process.env.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET;

const app = createTestApp();
const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const makeBusiness = async (label = 'A') => {
  const business = await Business.create({ name: `${label} Biz` });
  const admin = await User.create({
    name: `${label} Admin`,
    email: `${label}-${Date.now()}-${Math.random()}@example.com`,
    password: 'irrelevant-hash',
    role: 'admin',
    authProvider: 'local',
    businessId: business._id,
  });
  return { business, admin, token: signToken(admin._id) };
};

const makeInvoice = async (businessId: unknown, total = 250) =>
  Invoice.create({
    businessId,
    invoiceNumber: `INV-TEST-${Math.random().toString(36).slice(2, 10)}`,
    lineItems: [{ description: 'Work', quantity: 1, unitPrice: total, total }],
    subtotal: total,
    total,
    status: 'sent',
    dueDate: new Date(Date.now() + 86400000),
  });

// Paystack signs the exact bytes it sends; the test does the same.
const sendWebhook = (payload: object, secret = PAYSTACK_SECRET) => {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', secret).update(body).digest('hex');
  return request(app)
    .post('/api/invoices/webhooks/paystack')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', signature)
    .send(body);
};

const chargeSuccess = (invoiceId: unknown, amountMajor: number, reference = `ref_${Math.random()}`, extra = {}) => ({
  event: 'charge.success',
  data: {
    reference,
    status: 'success',
    amount: Math.round(amountMajor * 100),
    currency: 'NGN',
    metadata: { invoice_id: String(invoiceId) },
    ...extra,
  },
});

beforeAll(async () => {
  await connect();
}, 120000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('Paystack webhook', () => {
  it('verifies the raw body — payloads containing quotes and angle brackets are accepted', async () => {
    const { business } = await makeBusiness();
    const invoice = await makeInvoice(business._id);

    // The old code re-serialised the sanitised body, so these characters broke the HMAC.
    const res = await sendWebhook(
      chargeSuccess(invoice._id, 250, 'ref_quotes', {
        customer: { first_name: "Seán O'Brien", last_name: 'Smith "Jr"', note: '<b>vip</b>' },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('processed');
    const updated = await Invoice.findById(invoice._id);
    expect(updated!.status).toBe('paid');
    expect(updated!.payments[0]!.reference).toBe('ref_quotes');
  });

  it('records the income transaction with a recorder (the old webhook failed validation here)', async () => {
    const { business, admin } = await makeBusiness();
    const invoice = await makeInvoice(business._id);

    await sendWebhook(chargeSuccess(invoice._id, 250, 'ref_recorder'));

    const txs = await Transaction.find({ businessId: business._id });
    expect(txs).toHaveLength(1);
    expect(String(txs[0]!.recordedBy)).toBe(String(admin._id));
    expect(txs[0]!.externalId).toBe('ref_recorder');
  });

  it('rejects an invalid signature and records nothing', async () => {
    const { business } = await makeBusiness();
    const invoice = await makeInvoice(business._id);

    const res = await sendWebhook(chargeSuccess(invoice._id, 250), 'wrong-secret');

    expect(res.status).toBe(401);
    expect(await Transaction.countDocuments()).toBe(0);
    expect((await Invoice.findById(invoice._id))!.status).toBe('sent');
  });

  it('is idempotent when the same event is re-delivered', async () => {
    const { business } = await makeBusiness();
    const invoice = await makeInvoice(business._id);
    const event = chargeSuccess(invoice._id, 100, 'ref_repeat');

    const first = await sendWebhook(event);
    const second = await sendWebhook(event);

    expect(first.body.result).toBe('processed');
    expect(second.status).toBe(200);
    expect(second.body.result).toBe('duplicate');
    expect(await Transaction.countDocuments()).toBe(1);
    expect((await Invoice.findById(invoice._id))!.payments).toHaveLength(1);
  });

  it('is idempotent under concurrent duplicate deliveries', async () => {
    const { business } = await makeBusiness();
    const invoice = await makeInvoice(business._id);
    const event = chargeSuccess(invoice._id, 100, 'ref_race');

    const results = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(event)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.result === 'processed')).toHaveLength(1);
    expect(await Transaction.countDocuments()).toBe(1);
    const updated = await Invoice.findById(invoice._id);
    expect(updated!.payments).toHaveLength(1);
    expect(updated!.status).toBe('partial');
  });

  it('records the amount Paystack actually charged, not the invoice balance', async () => {
    const { business } = await makeBusiness();
    const invoice = await makeInvoice(business._id, 250);

    await sendWebhook(chargeSuccess(invoice._id, 75.5, 'ref_partial'));

    const updated = await Invoice.findById(invoice._id);
    expect(updated!.status).toBe('partial');
    expect(updated!.amountPaid).toBeCloseTo(75.5);
    expect(updated!.balance).toBeCloseTo(174.5);
  });

  it('ignores a charge in an unexpected currency', async () => {
    const { business } = await makeBusiness();
    const invoice = await makeInvoice(business._id);

    const res = await sendWebhook(chargeSuccess(invoice._id, 250, 'ref_usd', { currency: 'USD' }));

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ignored');
    expect(await Transaction.countDocuments()).toBe(0);
  });
});

describe('manual payments', () => {
  it('replays the original response for a repeated Idempotency-Key', async () => {
    const { business, token } = await makeBusiness();
    const invoice = await makeInvoice(business._id, 250);
    const key = 'pay-key-1234567890';

    const pay = () =>
      request(app)
        .post(`/api/invoices/${invoice._id}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ amount: 100, method: 'bank transfer' });

    const first = await pay();
    const second = await pay();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body._id).toBe(first.body._id);
    expect(await Transaction.countDocuments()).toBe(1);
  });

  it('rejects reusing an Idempotency-Key on a different endpoint', async () => {
    const { business, token } = await makeBusiness();
    const a = await makeInvoice(business._id);
    const b = await makeInvoice(business._id);
    const key = 'shared-key-1234567890';

    await request(app).post(`/api/invoices/${a._id}/payments`).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key).send({ amount: 10 });
    const res = await request(app).post(`/api/invoices/${b._id}/payments`).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key).send({ amount: 10 });

    expect(res.status).toBe(422);
    expect(await Transaction.countDocuments()).toBe(1);
  });

  it('never accepts concurrent payments that together exceed the balance', async () => {
    const { business, token } = await makeBusiness();
    const invoice = await makeInvoice(business._id, 250);

    const results = await Promise.all(
      [200, 200].map((amount) =>
        request(app)
          .post(`/api/invoices/${invoice._id}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .send({ amount }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const updated = await Invoice.findById(invoice._id);
    expect(updated!.amountPaid).toBe(200);
    expect(await Transaction.countDocuments()).toBe(1);
  });

  it('undoes the last payment and its transaction together', async () => {
    const { business, token } = await makeBusiness();
    const invoice = await makeInvoice(business._id, 250);
    await request(app).post(`/api/invoices/${invoice._id}/payments`).set('Authorization', `Bearer ${token}`).send({ amount: 50 });

    const res = await request(app)
      .delete(`/api/invoices/${invoice._id}/payments/last`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(await Transaction.countDocuments()).toBe(0);
  });
});

describe('recurring invoices', () => {
  it('generates exactly one invoice even if the job runs twice at once', async () => {
    const { business } = await makeBusiness();
    await RecurringInvoice.create({
      businessId: business._id,
      customClientName: 'Retainer client',
      lineItems: [{ description: 'Retainer', quantity: 1, unitPrice: 500, total: 500 }],
      subtotal: 500,
      tax: 0,
      total: 500,
      frequency: 'monthly',
      dueDaysAfter: 7,
      nextRunDate: new Date(Date.now() - 1000),
      isActive: true,
    });

    await Promise.all([generateDueRecurringInvoices(), generateDueRecurringInvoices()]);

    const invoices = await Invoice.find({ businessId: business._id });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.invoiceNumber).toMatch(/^INV-\d{6}-[0-9A-F]{8}$/);
  });
});

describe('input handling', () => {
  it('treats regex characters in search as literal text', async () => {
    const { token } = await makeBusiness();
    const res = await request(app).get('/api/invoices?search=(((a%2B)%2B)%2B').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("keeps apostrophes in names (O'Brien) but still strips HTML tags", async () => {
    const { token, business } = await makeBusiness();
    const res = await request(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: "Seán O'Brien <script>", email: "sean@example.com" });

    expect(res.status).toBe(201);
    const client = await Client.findOne({ businessId: business._id });
    expect(client!.name).toBe("Seán O'Brien script");
  });

  it('still logs in users whose password was hashed after the old sanitiser stripped quotes, then migrates them', async () => {
    const { business } = await makeBusiness();
    const realPassword = `it's-"secret"-<1>`;
    const legacyHashed = await bcrypt.hash(realPassword.replace(/[<>"']/g, ''), 10);
    const user = await User.create({
      name: 'Legacy',
      email: 'legacy@example.com',
      password: legacyHashed,
      role: 'admin',
      authProvider: 'local',
      businessId: business._id,
    });

    const res = await request(app).post('/api/users/login').send({ email: 'legacy@example.com', password: realPassword });
    expect(res.status).toBe(200);

    const migrated = await User.findById(user._id);
    expect(await bcrypt.compare(realPassword, migrated!.password!)).toBe(true);

    const wrong = await request(app).post('/api/users/login').send({ email: 'legacy@example.com', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
  });
});
