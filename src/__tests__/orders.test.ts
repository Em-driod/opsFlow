import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import Transaction from '../models/Transaction.js';
import Receipt from '../models/Receipt.js';
import BankCredit from '../models/BankCredit.js';
import '../models/Client.js';
import { parseBankAlert, parseGmailForwardingConfirmation } from '../utils/alertParser.js';

process.env.INBOUND_EMAIL_SECRET = 'test-inbound-secret';
process.env.INBOUND_EMAIL_DOMAIN = 'alerts.test';

const app = createTestApp();
const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// A business with a published page, bank details, ordering switched on and
// two catalog items: rice (stock tracked, 5 left) and delivery (untracked).
const makeShop = async (label: string) => {
  const business = await Business.create({
    name: `${label} Shop`,
    currency: 'NGN',
    slug: `${label.toLowerCase()}-shop`,
    profile: { isPublic: true, bankName: 'GTBank', accountNumber: '0123456789', accountName: `${label} Shop` },
    payments: { ordersEnabled: true },
  });
  const admin = await User.create({
    name: `${label} Admin`,
    email: `${label}-${Date.now()}-${Math.random()}@example.com`,
    password: 'irrelevant-hash',
    role: 'admin',
    authProvider: 'local',
    businessId: business._id,
  });
  business.owner = admin._id as never;
  await business.save();
  const rice = await Product.create({ businessId: business._id, name: 'Rice Bag', price: 5000, costPrice: 3000, trackStock: true, stock: 5 });
  const oil = await Product.create({ businessId: business._id, name: 'Palm Oil', price: 2500 });
  return { business, admin, token: signToken(admin._id), rice, oil };
};

const placeOrder = (slug: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/orders/public/${slug}`)
    .send({ name: 'Ade Bola', phone: '08012345678', email: 'ade@example.com', deliveryMethod: 'pickup', ...body });

const alertAddressFor = async (token: string) => {
  const res = await request(app).get('/api/payments/settings').set(auth(token));
  return res.body.email.address as string;
};

const sendAlert = (to: string, subject: string, text: string, messageId = `<${Math.random()}@bank>`) =>
  request(app)
    .post('/api/payments/webhooks/email?secret=test-inbound-secret')
    .send({ items: [{ MessageId: messageId, Subject: subject, To: [{ Address: to }], RawTextBody: text, SentAtDate: new Date().toISOString() }] });

beforeAll(async () => {
  await connect();
}, 60000);
afterEach(async () => {
  await clearDatabase();
});
afterAll(async () => {
  await closeDatabase();
});

describe('alert parser', () => {
  it('reads labelled GTBank-style alerts', () => {
    const r = parseBankAlert({
      subject: 'GeNS Transaction Alert [Credit: NGN 10,000.00]',
      text: 'Account Number: 012****789\nTransaction Type: Credit\nAmount: NGN 10,000.00\nDescription: TRF FROM ADE BOLA/MR7K4Q2P\nAvailable Balance: NGN 250,000.00',
    });
    expect(r).toMatchObject({ direction: 'credit', amount: 10000 });
    expect(r.narration).toContain('MR7K4Q2P');
  });

  it('reads "you received" fintech alerts and skips the balance', () => {
    const r = parseBankAlert({
      subject: 'You received money',
      text: 'Your balance is ₦45,000.00. You received ₦7,500 from JOHN DOE. Remark: order MR2H3J4K',
    });
    expect(r).toMatchObject({ direction: 'credit', amount: 7500 });
  });

  it('reads HTML alerts', () => {
    const r = parseBankAlert({
      subject: 'Credit Alert',
      html: '<table><tr><td>Txn Type</td><td>CR</td></tr><tr><td>Amt</td><td>NGN 2,500.50</td></tr><tr><td>Narration</td><td>MRABC123 rice</td></tr></table>',
    });
    expect(r).toMatchObject({ direction: 'credit', amount: 2500.5 });
  });

  it('marks debits as debits and reads no amount', () => {
    const r = parseBankAlert({ subject: 'Debit Alert', text: 'Transaction Type: Debit\nAmount: NGN 3,000.00' });
    expect(r).toMatchObject({ direction: 'debit', amount: null });
  });

  it('extracts the Gmail forwarding confirmation code', () => {
    const v = parseGmailForwardingConfirmation(
      '(#123456789) Gmail Forwarding Confirmation - Receive Mail from shop@gmail.com',
      'Confirmation code: 123456789 To allow shop@gmail.com to automatically forward mail, click https://mail-settings.google.com/mail/vf-abc123',
    );
    expect(v).toEqual({ code: '123456789', link: 'https://mail-settings.google.com/mail/vf-abc123' });
  });
});

describe('placing an order', () => {
  it('appears on the public profile with product ids and ordering switched on', async () => {
    const { business, rice } = await makeShop('A');
    const res = await request(app).get(`/api/businesses/public/${business.slug}`);
    expect(res.body.ordering).toEqual({ enabled: true });
    expect(res.body.profile.services.find((s: { name: string }) => s.name === 'Rice Bag').productId).toBe(String(rice._id));
  });

  it('prices from the catalog, merges repeated items and shows bank details to pay into', async () => {
    const { business, rice, oil } = await makeShop('A');
    const res = await placeOrder(business.slug!, {
      items: [
        { productId: String(rice._id), quantity: 1, price: 1 },
        { productId: String(rice._id), quantity: 1 },
        { productId: String(oil._id), quantity: 2 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(15000); // 2 × 5,000 + 2 × 2,500
    expect(res.body.code).toMatch(/^MR[A-Z2-9]{6}$/);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.payTo[0]).toMatchObject({ bankName: 'GTBank', accountNumber: '0123456789' });

    const tracked = await request(app).get(`/api/orders/public/track/${res.body.token}`);
    expect(tracked.body.code).toBe(res.body.code);
  });

  it('refuses more than the stock on hand, empty carts and missing delivery addresses', async () => {
    const { business, rice } = await makeShop('A');
    const tooMany = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 6 }] });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.message).toMatch(/Only 5/);

    expect((await placeOrder(business.slug!, { items: [] })).status).toBe(400);
    const noAddress = await placeOrder(business.slug!, { deliveryMethod: 'delivery', items: [{ productId: String(rice._id), quantity: 1 }] });
    expect(noAddress.status).toBe(400);
  });

  it('is closed when ordering is off, and cannot be switched on without bank details', async () => {
    const { business, rice, token } = await makeShop('A');
    await request(app).put('/api/payments/settings').set(auth(token)).send({ ordersEnabled: false });
    expect((await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] })).status).toBe(400);

    await Business.updateOne({ _id: business._id }, { $unset: { 'profile.accountNumber': 1 } });
    const res = await request(app).put('/api/payments/settings').set(auth(token)).send({ ordersEnabled: true });
    expect(res.status).toBe(400);
  });
});

describe('confirming payment', () => {
  it('by the owner records income, issues a receipt and reduces stock — once', async () => {
    const { business, rice, token } = await makeShop('A');
    const placed = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 2 }] });
    const order = await Order.findOne({ code: placed.body.code });

    const res = await request(app).post(`/api/orders/${order!._id}/confirm-payment`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(res.body.receipt.receiptNumber).toMatch(/^RCP-/);

    expect(await Transaction.countDocuments({ businessId: business._id, type: 'income', amount: 10000 })).toBe(1);
    const receipt = await Receipt.findById(res.body.receiptId).select('+items.unitCost').lean();
    expect(receipt!.items[0]).toMatchObject({ productId: rice._id, quantity: 2, unitCost: 3000 });
    expect((await Product.findById(rice._id))!.stock).toBe(3);

    const again = await request(app).post(`/api/orders/${order!._id}/confirm-payment`).set(auth(token));
    expect(again.status).toBe(400);
    expect(await Transaction.countDocuments({ businessId: business._id, type: 'income' })).toBe(1);
  });

  it('shows the receipt link to the customer once paid, and hides bank details', async () => {
    const { business, rice, token } = await makeShop('A');
    const placed = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    const order = await Order.findOne({ code: placed.body.code });
    await request(app).post(`/api/orders/${order!._id}/confirm-payment`).set(auth(token));

    const tracked = await request(app).get(`/api/orders/public/track/${placed.body.token}`);
    expect(tracked.body.status).toBe('paid');
    expect(tracked.body.receiptToken).toBeTruthy();
    expect(tracked.body.payTo).toEqual([]);
  });
});

describe('forwarded bank alerts', () => {
  it('rejects a wrong secret', async () => {
    const res = await request(app).post('/api/payments/webhooks/email?secret=nope').send({ items: [] });
    expect(res.status).toBe(403);
  });

  it('marks the order paid when the alert carries its code, and ignores a repeat of the same alert', async () => {
    const { business, rice, token } = await makeShop('A');
    const placed = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    const to = await alertAddressFor(token);
    expect(to).toMatch(/^pay-[a-f0-9]+@alerts\.test$/);

    const text = `Transaction Type: Credit\nAmount: NGN 5,000.00\nNarration: TRF ${placed.body.code.slice(0, 4)} ${placed.body.code.slice(4)} FROM ADE`;
    const first = await sendAlert(to, 'Credit Alert', text, '<same@bank>');
    expect(first.body.results[0].outcome).toMatch(/matched order/);

    const order = await Order.findOne({ code: placed.body.code });
    expect(order).toMatchObject({ status: 'paid', paymentSource: 'email_alert', matchedBy: 'code' });

    const repeat = await sendAlert(to, 'Credit Alert', text, '<same@bank>');
    expect(repeat.body.results[0].outcome).toBe('Already received');
    expect(await Transaction.countDocuments({ businessId: business._id, type: 'income' })).toBe(1);
  });

  it('only suggests an amount-only match by default, leaving the order for the owner to confirm', async () => {
    const { business, rice, oil, token } = await makeShop('A');
    const placed = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    await placeOrder(business.slug!, { items: [{ productId: String(oil._id), quantity: 1 }] });
    const to = await alertAddressFor(token);

    await sendAlert(to, 'Credit Alert', 'Txn Type: CR\nAmt: NGN 5,000.00\nNarration: transfer');
    expect((await Order.findOne({ code: placed.body.code }))!.status).toBe('pending_payment');
    expect(await Transaction.countDocuments({ businessId: business._id, type: 'income' })).toBe(0);
  });

  it('matches by exact amount with no code when the owner has turned that on', async () => {
    const { business, rice, oil, token } = await makeShop('A');
    await Business.updateOne({ _id: business._id }, { $set: { 'payments.autoMatchByAmount': true } });
    const placed = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    await placeOrder(business.slug!, { items: [{ productId: String(oil._id), quantity: 1 }] });
    const to = await alertAddressFor(token);

    await sendAlert(to, 'Credit Alert', 'Txn Type: CR\nAmt: NGN 5,000.00\nNarration: transfer');
    expect((await Order.findOne({ code: placed.body.code }))!.matchedBy).toBe('amount');
  });

  it('leaves ambiguous or short payments for the owner to match by hand', async () => {
    const { business, rice, token } = await makeShop('A');
    const one = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    const to = await alertAddressFor(token);

    await sendAlert(to, 'Credit Alert', 'Transaction Type: Credit\nAmount: NGN 5,000.00\nNarration: transfer');
    await sendAlert(to, 'Credit Alert', `Transaction Type: Credit\nAmount: NGN 4,000.00\nNarration: ${one.body.code}`);
    expect(await Order.countDocuments({ status: 'paid' })).toBe(0);

    const credits = await request(app).get('/api/payments/credits?status=unmatched').set(auth(token));
    expect(credits.body).toHaveLength(2);
    const short = credits.body.find((c: { amount: number }) => c.amount === 4000);
    expect(short.suggestedOrder.code).toBe(one.body.code);

    const exact = credits.body.find((c: { amount: number }) => c.amount === 5000);
    const order = await Order.findOne({ code: one.body.code });
    const matched = await request(app).post(`/api/payments/credits/${exact._id}/match`).set(auth(token)).send({ orderId: String(order!._id) });
    expect(matched.status).toBe(200);
    expect((await Order.findById(order!._id))!.status).toBe('paid');
  });

  it('ignores debit alerts and keeps a log of what arrived', async () => {
    const { token } = await makeShop('A');
    const to = await alertAddressFor(token);
    await sendAlert(to, 'Debit Alert', 'Transaction Type: Debit\nAmount: NGN 3,000.00');
    expect(await BankCredit.countDocuments()).toBe(0);

    const settings = await request(app).get('/api/payments/settings').set(auth(token));
    expect(settings.body.email.recentAlerts[0].outcome).toBe('Debit alert — ignored');
  });

  it('stores the Gmail forwarding confirmation code for the owner', async () => {
    const { token } = await makeShop('A');
    const to = await alertAddressFor(token);
    await sendAlert(to, '(#555666777) Gmail Forwarding Confirmation - Receive Mail from shop@gmail.com', 'Confirmation code: 555666777');
    const settings = await request(app).get('/api/payments/settings').set(auth(token));
    expect(settings.body.email.forwardingVerification.code).toBe('555666777');
  });

  it("only touches the business whose address received the alert", async () => {
    const a = await makeShop('A');
    const b = await makeShop('B');
    const placedB = await placeOrder(b.business.slug!, { items: [{ productId: String(b.rice._id), quantity: 1 }] });
    const toA = await alertAddressFor(a.token);
    await sendAlert(toA, 'Credit Alert', `Transaction Type: Credit\nAmount: NGN 5,000.00\nNarration: ${placedB.body.code}`);
    expect((await Order.findOne({ code: placedB.body.code }))!.status).toBe('pending_payment');
  });
});

describe('order management', () => {
  it('lists orders with status counts, fulfils paid ones and cancels unpaid ones', async () => {
    const { business, rice, oil, token } = await makeShop('A');
    const p1 = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    const p2 = await placeOrder(business.slug!, { items: [{ productId: String(oil._id), quantity: 1 }] });
    const o1 = await Order.findOne({ code: p1.body.code });
    const o2 = await Order.findOne({ code: p2.body.code });

    await request(app).post(`/api/orders/${o1!._id}/confirm-payment`).set(auth(token));
    expect((await request(app).put(`/api/orders/${o1!._id}/status`).set(auth(token)).send({ status: 'fulfilled' })).body.status).toBe('fulfilled');
    expect((await request(app).put(`/api/orders/${o2!._id}/status`).set(auth(token)).send({ status: 'fulfilled' })).status).toBe(400);
    expect((await request(app).put(`/api/orders/${o2!._id}/status`).set(auth(token)).send({ status: 'cancelled' })).body.status).toBe('cancelled');

    const list = await request(app).get('/api/orders').set(auth(token));
    expect(list.body.counts).toMatchObject({ fulfilled: 1, cancelled: 1, pending_payment: 0 });
  });

  it("can't see another business's orders", async () => {
    const a = await makeShop('A');
    const b = await makeShop('B');
    const placed = await placeOrder(a.business.slug!, { items: [{ productId: String(a.rice._id), quantity: 1 }] });
    const order = await Order.findOne({ code: placed.body.code });
    expect((await request(app).get(`/api/orders/${order!._id}`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).post(`/api/orders/${order!._id}/confirm-payment`).set(auth(b.token))).status).toBe(404);
  });
});

describe('order progress', () => {
  const paidOrder = async (deliveryMethod: 'pickup' | 'delivery' = 'pickup') => {
    const shop = await makeShop('A');
    const placed = await placeOrder(shop.business.slug!, {
      deliveryMethod,
      ...(deliveryMethod === 'delivery' ? { address: '12 Allen Avenue, Ikeja' } : {}),
      items: [{ productId: String(shop.rice._id), quantity: 1 }],
    });
    const order = await Order.findOne({ code: placed.body.code });
    await request(app).post(`/api/orders/${order!._id}/confirm-payment`).set(auth(shop.token));
    return { ...shop, order: order!, token: shop.token, publicToken: placed.body.token as string };
  };
  const stage = (token: string, id: unknown, body: Record<string, unknown>) =>
    request(app).put(`/api/orders/${id}/stage`).set(auth(token)).send(body);

  it('records placed and paid automatically and offers the right next steps', async () => {
    const { token, order } = await paidOrder('pickup');
    const res = await request(app).get(`/api/orders/${order._id}`).set(auth(token));
    expect(res.body.progress.map((p: { stage: string }) => p.stage)).toEqual(['placed', 'paid']);
    expect(res.body.nextStages).toEqual(['preparing', 'ready', 'completed']);
  });

  it('walks a pickup order to completion and shows each step to the customer', async () => {
    const { token, order, publicToken } = await paidOrder('pickup');
    expect((await stage(token, order._id, { stage: 'preparing' })).status).toBe(200);
    const ready = await stage(token, order._id, { stage: 'ready', note: 'Ask for Bisi at the counter' });
    expect(ready.body.stage).toBe('ready');

    const tracked = await request(app).get(`/api/orders/public/track/${publicToken}`);
    expect(tracked.body.stage).toBe('ready');
    expect(tracked.body.progress.at(-1)).toMatchObject({ stage: 'ready', note: 'Ask for Bisi at the counter' });

    const done = await stage(token, order._id, { stage: 'completed' });
    expect(done.body.status).toBe('fulfilled');
  });

  it('refuses the wrong step for the delivery method, going backwards, and steps before payment', async () => {
    const { token, order, business, rice } = await paidOrder('delivery');
    expect((await stage(token, order._id, { stage: 'ready' })).status).toBe(400);
    await stage(token, order._id, { stage: 'out_for_delivery' });
    expect((await stage(token, order._id, { stage: 'preparing' })).status).toBe(400);

    const unpaid = await placeOrder(business.slug!, { items: [{ productId: String(rice._id), quantity: 1 }] });
    const unpaidOrder = await Order.findOne({ code: unpaid.body.code });
    expect((await stage(token, unpaidOrder!._id, { stage: 'preparing' })).status).toBe(400);
  });

  it('undoes the last step, reopening a completed order', async () => {
    const { token, order } = await paidOrder('pickup');
    await stage(token, order._id, { stage: 'completed' });
    const res = await request(app).post(`/api/orders/${order._id}/stage/undo`).set(auth(token));
    expect(res.body.status).toBe('paid');
    expect(res.body.stage).toBe('paid');
  });
});
