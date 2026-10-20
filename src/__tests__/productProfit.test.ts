import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Product from '../models/Product.js';
import Invoice from '../models/Invoice.js';
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Worked example used throughout: 10 bags at 5,000 each, costing 3,000 each
// → 50,000 revenue, 30,000 cost, 20,000 booked profit (40% margin).
const createRiceProduct = async (token: string, costPrice: number | null = 3000) => {
  const res = await request(app).post('/api/products').set(auth(token)).send({ name: 'Rice Bag', price: 5000, costPrice });
  expect(res.status).toBe(201);
  return res.body._id as string;
};

const riceLine = (productId: string, quantity = 10) => ({
  description: 'Rice Bag',
  quantity,
  unitPrice: 5000,
  total: 5000 * quantity,
  productId,
});

const createInvoice = (token: string, body: Record<string, unknown>) =>
  request(app).post('/api/invoices').set(auth(token)).send({ customClientName: 'Ade', ...body });

const getProfit = async (token: string, query = '') => {
  const res = await request(app).get(`/api/reporting/product-profit${query}`).set(auth(token));
  expect(res.status).toBe(200);
  return res.body;
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

describe('cost price on products', () => {
  it('is returned to the owner but hidden from default queries', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const id = await createRiceProduct(token);

    const list = await request(app).get('/api/products').set(auth(token));
    expect(list.body[0].costPrice).toBe(3000);

    const plain = await Product.findById(id).lean();
    expect(plain).not.toHaveProperty('costPrice');
  });

  it('treats a blank cost as "not set" and rejects negatives', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const id = await createRiceProduct(token);

    const cleared = await request(app).put(`/api/products/${id}`).set(auth(token)).send({ costPrice: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.costPrice).toBeNull();

    const bad = await request(app).put(`/api/products/${id}`).set(auth(token)).send({ costPrice: -5 });
    expect(bad.status).toBe(400);
  });
});

describe('sale-time cost snapshot', () => {
  it('captures the cost when the invoice is created, ignoring a client-sent cost', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);

    const res = await createInvoice(token, { lineItems: [{ ...riceLine(productId), unitCost: 1 }] });
    expect(res.status).toBe(201);

    const stored = await Invoice.findById(res.body._id).select('+lineItems.unitCost').lean();
    expect(stored!.lineItems[0]!.unitCost).toBe(3000);
  });

  it('keeps old sales at the old cost after the cost price changes', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    await createInvoice(token, { lineItems: [riceLine(productId)], depositAmount: 50000 });

    await request(app).put(`/api/products/${productId}`).set(auth(token)).send({ costPrice: 4000 });

    const report = await getProfit(token);
    expect(report.products[0].cost).toBe(30000);
    expect(report.products[0].profit).toBe(20000);
    expect(report.products[0].currentCostPrice).toBe(4000);
  });

  it('never exposes the cost on the public invoice link', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    const inv = await createInvoice(token, { lineItems: [riceLine(productId)] });

    const pub = await request(app).get(`/api/invoices/public/${inv.body._id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.lineItems[0]).not.toHaveProperty('unitCost');
  });

  it('never exposes the cost on the public receipt link', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    const rc = await request(app)
      .post('/api/receipts')
      .set(auth(token))
      .send({ payerName: 'Walk-in', description: 'Rice', items: [{ description: 'Rice Bag', amount: 5000, productId, quantity: 1 }] });

    const pub = await request(app).get(`/api/receipts/public/${rc.body.publicToken}`);
    expect(pub.status).toBe(200);
    expect(pub.body.receipt.items[0]).not.toHaveProperty('unitCost');
  });
});

describe('GET /api/reporting/product-profit', () => {
  it('splits profit into collected and outstanding for a part-paid invoice (proportional)', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    await createInvoice(token, { lineItems: [riceLine(productId)], depositAmount: 20000 });

    const { summary, products } = await getProfit(token);
    expect(summary).toMatchObject({
      revenue: 50000,
      cost: 30000,
      profit: 20000,
      margin: 40,
      collectedRevenue: 20000,
      collectedProfit: 8000,
      outstandingProfit: 12000,
    });
    expect(products[0]).toMatchObject({ name: 'Rice Bag', unitsSold: 10, salesCount: 1 });
  });

  it('recovers cost before counting profit with method=cost_first', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    const inv = await createInvoice(token, { lineItems: [riceLine(productId)], depositAmount: 20000 });

    let { summary } = await getProfit(token, '?method=cost_first');
    expect(summary.collectedProfit).toBe(0); // 20,000 paid < 30,000 cost

    await request(app).post(`/api/invoices/${inv.body._id}/payments`).set(auth(token)).send({ amount: 15000 });
    ({ summary } = await getProfit(token, '?method=cost_first'));
    expect(summary.collectedProfit).toBe(5000); // 35,000 paid − 30,000 cost
    expect(summary.outstandingProfit).toBe(15000);
  });

  it('measures the paid share against the taxed total but keeps tax out of profit', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    // 50,000 + 10% tax = 55,000; 22,000 paid = 40%.
    await createInvoice(token, { lineItems: [riceLine(productId)], tax: 10, depositAmount: 22000 });

    const { summary } = await getProfit(token);
    expect(summary.revenue).toBe(50000);
    expect(summary.profit).toBe(20000);
    expect(summary.collectedProfit).toBe(8000);
  });

  it('counts receipts as fully paid and excludes void invoices', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);

    await request(app)
      .post('/api/receipts')
      .set(auth(token))
      .send({ payerName: 'Walk-in', description: 'Rice', items: [{ description: 'Rice Bag x2', amount: 10000, productId, quantity: 2 }] });

    const voided = await createInvoice(token, { lineItems: [riceLine(productId)] });
    const voidRes = await request(app).put(`/api/invoices/${voided.body._id}/status`).set(auth(token)).send({ status: 'void' });
    expect(voidRes.status).toBe(200);

    const { summary } = await getProfit(token);
    expect(summary.revenue).toBe(10000);
    expect(summary.profit).toBe(4000);
    expect(summary.collectedProfit).toBe(4000);
    expect(summary.outstandingProfit).toBe(0);
  });

  it('does not double-count a receipt issued for an invoice payment', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    const inv = await createInvoice(token, { lineItems: [riceLine(productId)], depositAmount: 50000 });
    const paymentTx = String(inv.body.payments[0].transactionId);

    await request(app)
      .post('/api/receipts')
      .set(auth(token))
      .send({
        payerName: 'Ade',
        description: 'Payment',
        transactionIds: [paymentTx],
        items: [{ description: `Payment received for Invoice #${inv.body.invoiceNumber}`, amount: 50000, transactionId: paymentTx }],
      });

    const { summary } = await getProfit(token);
    expect(summary.revenue).toBe(50000);
    expect(summary.unlinked.lines).toBe(0);
  });

  it('falls back to the current cost for sales made before a cost was set, and flags products with none', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token, null);
    await createInvoice(token, { lineItems: [riceLine(productId)] });

    let report = await getProfit(token);
    expect(report.summary.missingCost).toEqual({ products: 1, revenue: 50000 });
    expect(report.summary.profit).toBe(0);
    expect(report.products[0].margin).toBeNull();

    await request(app).put(`/api/products/${productId}`).set(auth(token)).send({ costPrice: 3000 });
    report = await getProfit(token);
    expect(report.summary.missingCost.products).toBe(0);
    expect(report.summary.profit).toBe(20000);
  });

  it('filters by date range', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    await createInvoice(token, { lineItems: [riceLine(productId)] });

    const empty = await getProfit(token, '?from=2000-01-01&to=2000-12-31');
    expect(empty.summary.revenue).toBe(0);
    expect(empty.products).toHaveLength(0);
  });

  it('only sees its own business', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const productId = await createRiceProduct(a.token);
    await createInvoice(a.token, { lineItems: [riceLine(productId)] });

    const report = await getProfit(b.token);
    expect(report.summary.revenue).toBe(0);
  });

  it('returns the sales of one product for drill-down', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    await createInvoice(token, { lineItems: [riceLine(productId, 4)], depositAmount: 10000 });

    const { sales } = await getProfit(token, `?productId=${productId}`);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ source: 'invoice', customer: 'Ade', quantity: 4, revenue: 20000, profit: 8000, paidPercent: 50 });
  });
});

describe('POST /api/reporting/product-profit/link', () => {
  it('groups unlinked lines, suggests a product, and links every matching line', async () => {
    const { token } = await makeBusinessWithAdmin('A');
    const productId = await createRiceProduct(token);
    const typed = { description: 'rice  bag', quantity: 2, unitPrice: 5000, total: 10000 };
    await createInvoice(token, { lineItems: [typed] });
    await createInvoice(token, { lineItems: [{ ...typed, description: 'Rice Bag' }] });

    let report = await getProfit(token);
    expect(report.unlinked).toHaveLength(1);
    expect(report.unlinked[0]).toMatchObject({ lines: 2, revenue: 20000, suggestedProductId: productId });

    const link = await request(app)
      .post('/api/reporting/product-profit/link')
      .set(auth(token))
      .send({ description: report.unlinked[0].description, productId });
    expect(link.status).toBe(200);
    expect(link.body.invoicesUpdated).toBe(2);

    report = await getProfit(token);
    expect(report.unlinked).toHaveLength(0);
    expect(report.summary.profit).toBe(8000); // 4 bags × (5,000 − 3,000)
  });

  it('refuses a product from another business', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const productId = await createRiceProduct(a.token);
    const res = await request(app)
      .post('/api/reporting/product-profit/link')
      .set(auth(b.token))
      .send({ description: 'Rice Bag', productId });
    expect(res.status).toBe(404);
  });
});
