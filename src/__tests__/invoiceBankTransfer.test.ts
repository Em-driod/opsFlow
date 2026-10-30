import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Invoice from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import BankCredit from '../models/BankCredit.js';
import '../models/Client.js';

process.env.INBOUND_EMAIL_SECRET = 'test-inbound-secret';
process.env.INBOUND_EMAIL_DOMAIN = 'alerts.test';

const app = createTestApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const makeBusiness = async (label: string) => {
  const business = await Business.create({
    name: `${label} Biz`,
    currency: 'NGN',
    slug: `${label.toLowerCase()}-biz`,
    profile: { isPublic: true, bankName: 'GTBank', accountNumber: '0123456789', accountName: `${label} Biz` },
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
  return { business, token: jwt.sign({ id: admin._id }, process.env.JWT_SECRET!, { expiresIn: '1h' }) };
};

// ₦50,000 invoice
const createInvoice = async (token: string) => {
  const res = await request(app)
    .post('/api/invoices')
    .set(auth(token))
    .send({ customClientName: 'Ade', lineItems: [{ description: 'Design work', quantity: 1, unitPrice: 50000, total: 50000 }] });
  expect(res.status).toBe(201);
  return res.body as { _id: string; invoiceNumber: string; paymentCode: string };
};

const alertAddress = async (token: string) => (await request(app).get('/api/payments/settings').set(auth(token))).body.email.address as string;

const sendAlert = (to: string, amount: string, narration: string, messageId = `<${Math.random()}@bank>`) =>
  request(app)
    .post('/api/payments/webhooks/email?secret=test-inbound-secret')
    .send({
      items: [
        {
          MessageId: messageId,
          Subject: 'Credit Alert',
          To: [{ Address: to }],
          RawTextBody: `Transaction Type: Credit\nAmount: NGN ${amount}\nNarration: ${narration}`,
          SentAtDate: new Date().toISOString(),
        },
      ],
    });

beforeAll(async () => {
  await connect();
}, 60000);
afterEach(async () => {
  await clearDatabase();
});
afterAll(async () => {
  await closeDatabase();
});

describe('paying an invoice by bank transfer', () => {
  it('gives every invoice a payment code and shows the business’s bank account', async () => {
    const { token } = await makeBusiness('A');
    const inv = await createInvoice(token);
    expect(inv.paymentCode).toMatch(/^IV[A-Z2-9]{6}$/);

    const pub = await request(app).get(`/api/invoices/public/${inv._id}`);
    expect(pub.body.paymentCode).toBe(inv.paymentCode);
    expect(pub.body.businessId.profile).toMatchObject({ bankName: 'GTBank', accountNumber: '0123456789' });
  });

  it('gives an older invoice without a code one when it is first opened', async () => {
    const { token } = await makeBusiness('A');
    const inv = await createInvoice(token);
    await Invoice.updateOne({ _id: inv._id }, { $unset: { paymentCode: 1 } });

    const pub = await request(app).get(`/api/invoices/public/${inv._id}`);
    expect(pub.body.paymentCode).toMatch(/^IV/);
  });

  it('no longer takes card payments through the platform’s Paystack account', async () => {
    const { token } = await makeBusiness('A');
    const inv = await createInvoice(token);
    const res = await request(app).post(`/api/invoices/public/${inv._id}/pay/init`).send({ email: 'ade@example.com' });
    expect(res.status).toBe(410);
  });
});

describe('matching transfers to invoices', () => {
  it('records part payments from alerts carrying the code, then marks it paid', async () => {
    const { token, business } = await makeBusiness('A');
    const inv = await createInvoice(token);
    const to = await alertAddress(token);

    const first = await sendAlert(to, '20,000.00', `TRF FROM ADE ${inv.paymentCode}`);
    expect(first.body.results[0].outcome).toMatch(/matched invoice/);
    let stored = await Invoice.findById(inv._id);
    expect(stored!.status).toBe('partial');
    expect(stored!.balance).toBe(30000);

    await sendAlert(to, '30,000.00', `balance ${inv.paymentCode.toLowerCase()}`);
    stored = await Invoice.findById(inv._id);
    expect(stored!.status).toBe('paid');
    expect(await Transaction.countDocuments({ businessId: business._id, type: 'income' })).toBe(2);
  });

  it('matches by invoice number too, and never records the same alert twice', async () => {
    const { token } = await makeBusiness('A');
    const inv = await createInvoice(token);
    const to = await alertAddress(token);

    await sendAlert(to, '10,000.00', `payment for ${inv.invoiceNumber}`, '<same@bank>');
    const repeat = await sendAlert(to, '10,000.00', `payment for ${inv.invoiceNumber}`, '<same@bank>');
    expect(repeat.body.results[0].outcome).toBe('Already received');
    expect((await Invoice.findById(inv._id))!.payments).toHaveLength(1);
  });

  it('caps an overpayment at the balance and notes the extra', async () => {
    const { token } = await makeBusiness('A');
    const inv = await createInvoice(token);
    const to = await alertAddress(token);

    await sendAlert(to, '55,000.00', inv.paymentCode);
    const stored = await Invoice.findById(inv._id);
    expect(stored!.status).toBe('paid');
    expect(stored!.payments[0]!.amount).toBe(50000);
    expect(stored!.payments[0]!.note).toMatch(/Overpaid by 5000/);
  });

  it('suggests an amount-only match for the owner to confirm, then records it', async () => {
    const { token } = await makeBusiness('A');
    const inv = await createInvoice(token);
    const to = await alertAddress(token);

    await sendAlert(to, '50,000.00', 'transfer');
    expect((await Invoice.findById(inv._id))!.status).not.toBe('paid');

    const credits = await request(app).get('/api/payments/credits?status=unmatched').set(auth(token));
    expect(credits.body[0].suggestedInvoice.invoiceNumber).toBe(inv.invoiceNumber);

    const matched = await request(app)
      .post(`/api/payments/credits/${credits.body[0]._id}/match`)
      .set(auth(token))
      .send({ invoiceId: inv._id });
    expect(matched.status).toBe(200);
    expect((await Invoice.findById(inv._id))!.status).toBe('paid');
    expect((await BankCredit.findById(credits.body[0]._id))!.status).toBe('matched');
  });

  it('only touches the business whose alert address received the transfer', async () => {
    const a = await makeBusiness('A');
    const b = await makeBusiness('B');
    const invB = await createInvoice(b.token);
    await sendAlert(await alertAddress(a.token), '50,000.00', invB.paymentCode);
    expect((await Invoice.findById(invB._id))!.payments).toHaveLength(0);
  });
});

describe('client says they have paid', () => {
  it('records the nudge once and shows it on the invoice', async () => {
    const { token } = await makeBusiness('A');
    const inv = await createInvoice(token);
    const res = await request(app).post(`/api/invoices/public/${inv._id}/sent`);
    expect(res.status).toBe(200);
    expect(res.body.customerMarkedPaidAt).toBeTruthy();
  });
});
