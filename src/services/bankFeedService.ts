import mongoose from 'mongoose';
import crypto from 'crypto';
import axios from 'axios';
import Business from '../models/Business.js';
import Order from '../models/Order.js';
import BankCredit, { type CreditSource } from '../models/BankCredit.js';
import User from '../models/User.js';
import { markOrderPaid } from './orderService.js';
import { recordBankTransferPayment } from './invoiceService.js';
import Invoice from '../models/Invoice.js';
import { createNotification } from './notificationService.js';
import { emitToBusiness } from './socketService.js';
import { AppError } from '../utils/AppError.js';
import { isDuplicateKeyError } from '../utils/transaction.js';
import { parseBankAlert, parseGmailForwardingConfirmation, htmlToText } from '../utils/alertParser.js';
import type { IUser } from '../models/User.js';

// ─────────────────────────────────────────────────────────────────────────────
// Detecting money that lands in a business's own bank account, and matching
// it to open orders. Two feeds, both optional, both feeding recordCredit():
//
//   Forwarded bank alerts — the business forwards its bank's credit-alert
//   emails to a private address (pay-<token>@INBOUND_EMAIL_DOMAIN). An inbound
//   email service (e.g. Brevo inbound parsing) posts each one to
//   POST /api/payments/webhooks/email?secret=INBOUND_EMAIL_SECRET.
//
//   Linked bank (Mono) — the business links its account via Mono Connect; new
//   credits are pulled on Mono's webhook and by a periodic sync.
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_ORDER_WINDOW_DAYS = 14;
const RECENT_ALERTS_KEPT = 10;
const normaliseForSearch = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const notifyAdmins = async (businessId: mongoose.Types.ObjectId, message: string, link: string) => {
  const [business, admins] = await Promise.all([
    Business.findById(businessId).select('owner').lean(),
    User.find({ businessId, role: 'admin' }).select('_id').lean(),
  ]);
  const ids = new Set(admins.map((a) => String(a._id)));
  if (business?.owner) ids.add(String(business.owner));
  await Promise.all([...ids].map((id) => createNotification({ businessId, userId: new mongoose.Types.ObjectId(id), message, link })));
};

export type CreditOutcome =
  | { result: 'duplicate' }
  | { result: 'matched'; kind: 'order' | 'invoice'; ref: string; matchedBy: 'code' | 'amount' }
  | { result: 'unmatched'; reason: string };

const OPEN_INVOICE_STATUSES = ['draft', 'sent', 'partial', 'overdue'];

// Same rule as the Invoice model's `balance` virtual, for lean documents.
const invoiceBalance = (inv: { total: number; status: string; payments?: { amount: number }[] }) => {
  const recorded = (inv.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const paid = recorded > 0 ? recorded : inv.status === 'paid' ? inv.total : 0;
  return Math.max(0, Math.round((inv.total - paid) * 100) / 100);
};

/**
 * Records one money-in event and, when it clearly belongs to an open order or
 * invoice, applies it. Matching rules, strictest first:
 *   1. An order code is in the narration and the amount covers the order → order paid.
 *   2. An invoice's payment code (or its number) is in the narration → the
 *      amount is recorded on that invoice; part payments are fine.
 *   3. No code, but exactly one open order/invoice is owed exactly this amount
 *      → suggested to the owner, or applied if they turned on auto-matching.
 * Anything else is kept as an unmatched credit for the owner to match by hand.
 */
export const recordCredit = async (
  businessId: mongoose.Types.ObjectId,
  credit: { source: CreditSource; externalId: string; amount: number; narration?: string | null; searchText?: string; receivedAt?: Date },
): Promise<CreditOutcome> => {
  const amount = Math.round(credit.amount * 100) / 100;
  let doc;
  try {
    doc = await BankCredit.create({
      businessId,
      source: credit.source,
      externalId: credit.externalId,
      amount,
      ...(credit.narration ? { narration: credit.narration.slice(0, 300) } : {}),
      receivedAt: credit.receivedAt ?? new Date(),
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) return { result: 'duplicate' };
    throw e;
  }
  const creditId = doc._id as mongoose.Types.ObjectId;
  // The bank event's id is the payment reference on the invoice, so a credit
  // can only ever be recorded once.
  const reference = `credit:${creditId}`;

  const since = new Date(Date.now() - OPEN_ORDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [openOrders, invoiceDocs] = await Promise.all([
    Order.find({ businessId, status: 'pending_payment', createdAt: { $gte: since } }).select('code total').lean(),
    Invoice.find({ businessId, status: { $in: OPEN_INVOICE_STATUSES } })
      .select('invoiceNumber paymentCode total status payments')
      .lean(),
  ]);
  const openInvoices = invoiceDocs
    .map((i) => ({ _id: i._id, invoiceNumber: i.invoiceNumber, paymentCode: i.paymentCode, balance: invoiceBalance(i) }))
    .filter((i) => i.balance > 0);

  const haystack = normaliseForSearch(`${credit.narration ?? ''} ${credit.searchText ?? ''}`);

  const finish = async (status: 'matched' | 'unmatched', patch: Record<string, unknown>) => {
    await BankCredit.updateOne({ _id: creditId }, { $set: { status, ...patch } });
  };
  const refresh = () => {
    emitToBusiness(String(businessId), 'data_updated', { type: 'order', action: 'credit' });
    emitToBusiness(String(businessId), 'data_updated', { type: 'invoice', action: 'credit' });
  };
  const applyToInvoice = async (inv: (typeof openInvoices)[number], matchedBy: 'code' | 'amount'): Promise<CreditOutcome | null> => {
    const r = await recordBankTransferPayment(inv._id as mongoose.Types.ObjectId, { amount, source: credit.source, reference });
    if (r.outcome !== 'processed') return null;
    await finish('matched', { invoiceId: inv._id, ...(r.overpaid > 0 ? { note: `Overpaid by ${r.overpaid}` } : {}) });
    return { result: 'matched', kind: 'invoice', ref: inv.invoiceNumber, matchedBy };
  };

  // 1. Order code
  const byOrderCode = openOrders.find((o) => haystack.includes(o.code));
  if (byOrderCode) {
    if (amount + 0.01 >= byOrderCode.total) {
      const paid = await markOrderPaid(byOrderCode._id as mongoose.Types.ObjectId, {
        source: credit.source,
        matchedBy: 'code',
        amount,
        bankCreditId: creditId,
        paidAt: credit.receivedAt ?? new Date(),
      });
      if (paid) {
        await finish('matched', { orderId: byOrderCode._id });
        return { result: 'matched', kind: 'order', ref: byOrderCode.code, matchedBy: 'code' };
      }
    } else {
      await finish('unmatched', { suggestedOrderId: byOrderCode._id, note: `Short payment for ${byOrderCode.code}` });
      await notifyAdmins(
        businessId,
        `A transfer of ${amount} mentions order ${byOrderCode.code} but is less than its total (${byOrderCode.total}). Review it in Orders.`,
        '/orders?tab=payments',
      );
      refresh();
      return { result: 'unmatched', reason: 'short_payment' };
    }
  }

  // 2. Invoice code (or the invoice number itself)
  const byInvoiceCode = openInvoices.find(
    (i) => (i.paymentCode && haystack.includes(i.paymentCode)) || haystack.includes(normaliseForSearch(i.invoiceNumber)),
  );
  if (byInvoiceCode) {
    const matched = await applyToInvoice(byInvoiceCode, 'code');
    if (matched) return matched;
  }

  // 3. Amount only
  const candidates = [
    ...openOrders.filter((o) => Math.abs(o.total - amount) < 0.01).map((o) => ({ kind: 'order' as const, id: o._id, ref: o.code, order: o })),
    ...openInvoices.filter((i) => Math.abs(i.balance - amount) < 0.01).map((i) => ({ kind: 'invoice' as const, id: i._id, ref: i.invoiceNumber, invoice: i })),
  ];
  const autoMatchByAmount = !!(await Business.findById(businessId).select('payments.autoMatchByAmount').lean())?.payments?.autoMatchByAmount;

  if (candidates.length === 1 && !autoMatchByAmount) {
    // No code, so we can't be sure the transfer is theirs — let the owner confirm.
    const only = candidates[0]!;
    await finish('unmatched', {
      ...(only.kind === 'order' ? { suggestedOrderId: only.id } : { suggestedInvoiceId: only.id }),
      note: `Same amount as ${only.kind} ${only.ref}, but no code — confirm it's theirs`,
    });
    await notifyAdmins(
      businessId,
      `A transfer of ${amount} has no code but equals ${only.kind} ${only.ref}. Confirm it in Orders → Unmatched payments if it's theirs.`,
      '/orders?tab=payments',
    );
    refresh();
    return { result: 'unmatched', reason: 'amount_needs_confirmation' };
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    if (only.kind === 'invoice') {
      const matched = await applyToInvoice(only.invoice, 'amount');
      if (matched) return matched;
    } else {
      const paid = await markOrderPaid(only.id as mongoose.Types.ObjectId, {
        source: credit.source,
        matchedBy: 'amount',
        amount,
        bankCreditId: creditId,
        paidAt: credit.receivedAt ?? new Date(),
      });
      if (paid) {
        await finish('matched', { orderId: only.id });
        return { result: 'matched', kind: 'order', ref: only.ref, matchedBy: 'amount' };
      }
    }
  }

  await finish('unmatched', candidates.length > 1 ? { note: `${candidates.length} open orders/invoices have this amount` } : {});
  refresh();
  return { result: 'unmatched', reason: candidates.length > 1 ? 'ambiguous_amount' : 'no_match' };
};

// ── Owner actions on credits ─────────────────────────────────────────────────

export const listCredits = async (businessId: mongoose.Types.ObjectId, status?: string) => {
  const filter: Record<string, unknown> = { businessId };
  if (status && ['matched', 'unmatched', 'dismissed'].includes(status)) filter.status = status;
  const credits = await BankCredit.find(filter).sort({ receivedAt: -1 }).limit(100).lean();
  const orderIds = credits.flatMap((c) => [c.orderId, c.suggestedOrderId]).filter(Boolean);
  const invoiceIds = credits.flatMap((c) => [c.invoiceId, c.suggestedInvoiceId]).filter(Boolean);
  const [orders, invoices] = await Promise.all([
    Order.find({ _id: { $in: orderIds } }).select('code total customer.name status').lean(),
    Invoice.find({ _id: { $in: invoiceIds } })
      .select('invoiceNumber total status payments customClientName clientId')
      .populate<{ clientId: { name?: string } | null }>('clientId', 'name')
      .lean(),
  ]);
  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const invoiceById = new Map(
    invoices.map((i) => [
      String(i._id),
      { _id: i._id, invoiceNumber: i.invoiceNumber, total: i.total, balance: invoiceBalance(i), status: i.status, clientName: i.clientId?.name || i.customClientName || '' },
    ]),
  );
  return credits.map((c) => ({
    ...c,
    order: c.orderId ? orderById.get(String(c.orderId)) ?? null : null,
    suggestedOrder: c.suggestedOrderId ? orderById.get(String(c.suggestedOrderId)) ?? null : null,
    invoice: c.invoiceId ? invoiceById.get(String(c.invoiceId)) ?? null : null,
    suggestedInvoice: c.suggestedInvoiceId ? invoiceById.get(String(c.suggestedInvoiceId)) ?? null : null,
  }));
};

// The owner says an unmatched transfer was for this invoice — record it there.
export const matchCreditToInvoice = async (creditId: string, invoiceId: string, user: IUser) => {
  if (!mongoose.isValidObjectId(creditId) || !mongoose.isValidObjectId(invoiceId)) throw new AppError('Not found', 404);
  const credit = await BankCredit.findOne({ _id: creditId, businessId: user.businessId });
  if (!credit) throw new AppError('Payment not found', 404);
  if (credit.status === 'matched') throw new AppError('This payment is already matched', 400);
  const invoice = await Invoice.findOne({ _id: invoiceId, businessId: user.businessId }).select('_id status');
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) throw new AppError('That invoice has nothing left to pay', 400);

  const r = await recordBankTransferPayment(invoice._id as mongoose.Types.ObjectId, {
    amount: credit.amount,
    source: credit.source,
    reference: `credit:${credit._id}`,
    user,
  });
  if (r.outcome !== 'processed') throw new AppError('That invoice has nothing left to pay', 400);
  credit.status = 'matched';
  credit.invoiceId = invoice._id as mongoose.Types.ObjectId;
  if (r.overpaid > 0) credit.note = `Overpaid by ${r.overpaid}`;
  await credit.save();
  return credit;
};

export const matchCreditToOrder = async (creditId: string, orderId: string, user: IUser) => {
  if (!mongoose.isValidObjectId(creditId) || !mongoose.isValidObjectId(orderId)) throw new AppError('Not found', 404);
  const credit = await BankCredit.findOne({ _id: creditId, businessId: user.businessId });
  if (!credit) throw new AppError('Payment not found', 404);
  if (credit.status === 'matched') throw new AppError('This payment is already matched to an order', 400);
  const order = await Order.findOne({ _id: orderId, businessId: user.businessId });
  if (!order) throw new AppError('Order not found', 404);
  if (order.status !== 'pending_payment') throw new AppError('That order is not awaiting payment', 400);

  const paid = await markOrderPaid(order._id as mongoose.Types.ObjectId, {
    source: credit.source,
    matchedBy: 'manual',
    amount: credit.amount,
    bankCreditId: credit._id as mongoose.Types.ObjectId,
    user,
    paidAt: credit.receivedAt,
  });
  if (!paid) throw new AppError('That order is not awaiting payment', 400);
  credit.status = 'matched';
  credit.orderId = order._id as mongoose.Types.ObjectId;
  await credit.save();
  return credit;
};

export const dismissCredit = async (creditId: string, businessId: mongoose.Types.ObjectId) => {
  const credit = await BankCredit.findOneAndUpdate(
    { _id: creditId, businessId, status: 'unmatched' },
    { $set: { status: 'dismissed' } },
    { new: true },
  );
  if (!credit) throw new AppError('Payment not found', 404);
  return credit;
};

// ── Settings ─────────────────────────────────────────────────────────────────

const inboundDomain = () => (process.env.INBOUND_EMAIL_DOMAIN || '').trim().toLowerCase();
const alertAddress = (token?: string) => (token && inboundDomain() ? `pay-${token}@${inboundDomain()}` : null);
const monoConfigured = () => !!(process.env.MONO_SECRET_KEY && process.env.MONO_PUBLIC_KEY);

export const getPaymentSettings = async (businessId: mongoose.Types.ObjectId) => {
  const business = await Business.findById(businessId).select('slug profile.isPublic profile.accountNumber profile.accountNumber2 payments');
  if (!business) throw new AppError('Business not found', 404);

  // The alert address is created on first visit so every business has one ready.
  if (!business.payments?.alertToken) {
    business.set('payments.alertToken', crypto.randomBytes(6).toString('hex'));
    await business.save();
  }
  const p = business.payments!;
  const [unmatched, pending] = await Promise.all([
    BankCredit.countDocuments({ businessId, status: 'unmatched' }),
    Order.countDocuments({ businessId, status: 'pending_payment' }),
  ]);

  return {
    ordersEnabled: !!p.ordersEnabled,
    autoMatchByAmount: !!p.autoMatchByAmount,
    storefrontPublic: !!business.profile?.isPublic,
    storefrontSlug: business.slug ?? null,
    hasBankDetails: !!(business.profile?.accountNumber || business.profile?.accountNumber2),
    unmatchedCredits: unmatched,
    pendingOrders: pending,
    email: {
      available: !!inboundDomain(),
      address: alertAddress(p.alertToken),
      lastAlertAt: p.lastAlertAt ?? null,
      forwardingVerification: p.forwardingVerification?.receivedAt ? p.forwardingVerification : null,
      recentAlerts: p.recentAlerts ?? [],
    },
    mono: {
      available: monoConfigured(),
      publicKey: monoConfigured() ? process.env.MONO_PUBLIC_KEY : null,
      linked: !!p.mono?.accountId,
      accountName: p.mono?.accountName ?? null,
      accountNumber: p.mono?.accountNumber ?? null,
      institution: p.mono?.institution ?? null,
      linkedAt: p.mono?.linkedAt ?? null,
      lastSyncedAt: p.mono?.lastSyncedAt ?? null,
      lastError: p.mono?.lastError ?? null,
    },
  };
};

export const updatePaymentSettings = async (businessId: mongoose.Types.ObjectId, body: { ordersEnabled?: unknown; autoMatchByAmount?: unknown; regenerateAddress?: unknown }) => {
  const business = await Business.findById(businessId).select('profile.accountNumber profile.accountNumber2 payments');
  if (!business) throw new AppError('Business not found', 404);
  if (typeof body.ordersEnabled === 'boolean') {
    if (body.ordersEnabled && !(business.profile?.accountNumber || business.profile?.accountNumber2)) {
      throw new AppError('Add your bank details first — customers need an account to pay into', 400);
    }
    business.set('payments.ordersEnabled', body.ordersEnabled);
  }
  if (typeof body.autoMatchByAmount === 'boolean') business.set('payments.autoMatchByAmount', body.autoMatchByAmount);
  if (body.regenerateAddress === true) {
    business.set('payments.alertToken', crypto.randomBytes(6).toString('hex'));
    business.set('payments.forwardingVerification', undefined);
  }
  await business.save();
  return getPaymentSettings(businessId);
};

// ── Forwarded alert emails ───────────────────────────────────────────────────

interface InboundEmail {
  messageId?: string | undefined;
  subject: string;
  text: string;
  html: string;
  addresses: string[];
  receivedAt: Date;
}

// Accepts Brevo's inbound-parsing payload ({ items: [...] }) and also a simple
// { to, subject, text, html } shape so another provider can be swapped in.
const readInbound = (payload: unknown): InboundEmail[] => {
  const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v ? [v] : []);
  const addr = (v: unknown): string[] =>
    asList(v).flatMap((x) => {
      if (typeof x === 'string') return x.split(/[,;]/);
      const o = x as { Address?: string; address?: string; email?: string };
      return [o?.Address ?? o?.address ?? o?.email ?? ''];
    });

  const items = asList((payload as { items?: unknown })?.items ?? payload);
  return items.map((raw) => {
    const m = raw as Record<string, unknown>;
    const headers = (m.Headers ?? m.headers ?? {}) as Record<string, unknown>;
    const headerAddrs = ['Delivered-To', 'X-Forwarded-To', 'X-Original-To', 'Envelope-To', 'To', 'delivered-to', 'x-forwarded-to', 'x-original-to']
      .flatMap((h) => addr(headers[h]));
    const sent = String(m.SentAtDate ?? m.date ?? '');
    return {
      messageId: String(m.MessageId ?? m.messageId ?? m['Message-Id'] ?? '') || undefined,
      subject: String(m.Subject ?? m.subject ?? ''),
      text: String(m.RawTextBody ?? m.ExtractedMarkdownMessage ?? m.text ?? m.TextBody ?? ''),
      html: String(m.RawHtmlBody ?? m.html ?? m.HtmlBody ?? ''),
      addresses: [...addr(m.To ?? m.to), ...addr(m.Cc ?? m.cc), ...addr(m.Recipients ?? m.recipients), ...addr(m.envelope_to), ...headerAddrs]
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
      receivedAt: sent && !isNaN(Date.parse(sent)) ? new Date(sent) : new Date(),
    };
  });
};

const tokenFromAddresses = (addresses: string[]) => {
  for (const a of addresses) {
    const m = /pay-([a-f0-9]{8,32})@/i.exec(a);
    if (m) return m[1]!.toLowerCase();
  }
  return null;
};

export const handleInboundEmail = async (secret: unknown, rawBody: Buffer | undefined, parsedBody: unknown) => {
  const expected = process.env.INBOUND_EMAIL_SECRET;
  if (!expected) throw new AppError('Inbound email is not configured', 503);
  if (typeof secret !== 'string' || secret.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) {
    throw new AppError('Forbidden', 403);
  }

  let payload: unknown = parsedBody;
  if (rawBody?.length) {
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      /* fall back to the parsed body */
    }
  }

  const results: Array<{ token: string | null; outcome: string }> = [];
  for (const email of readInbound(payload)) {
    const token = tokenFromAddresses(email.addresses);
    if (!token) {
      results.push({ token: null, outcome: 'no_business' });
      continue;
    }
    const business = await Business.findOne({ 'payments.alertToken': token }).select('_id');
    if (!business) {
      results.push({ token, outcome: 'unknown_address' });
      continue;
    }
    const businessId = business._id as mongoose.Types.ObjectId;
    const plain = email.text.trim() ? email.text : htmlToText(email.html);

    let outcome: string;
    const verification = parseGmailForwardingConfirmation(email.subject, plain);
    if (verification) {
      await Business.updateOne({ _id: businessId }, { $set: { 'payments.forwardingVerification': { ...verification, receivedAt: new Date() } } });
      await notifyAdmins(businessId, 'Gmail sent a forwarding confirmation code — open Orders → Payment setup to finish turning on bank alerts.', '/orders?tab=setup');
      outcome = 'Gmail forwarding confirmation';
    } else {
      const parsed = parseBankAlert({ subject: email.subject, text: email.text, html: email.html });
      if (parsed.direction !== 'credit') {
        outcome = parsed.direction === 'debit' ? 'Debit alert — ignored' : 'Not a credit alert — ignored';
      } else if (!parsed.amount) {
        outcome = 'Credit alert, but the amount could not be read';
      } else {
        const externalId = email.messageId || crypto.createHash('sha256').update(parsed.text).digest('hex');
        const r = await recordCredit(businessId, {
          source: 'email_alert',
          externalId,
          amount: parsed.amount,
          narration: parsed.narration,
          searchText: parsed.text,
          receivedAt: email.receivedAt,
        });
        outcome =
          r.result === 'matched'
            ? `Credit ${parsed.amount} — matched ${r.kind} ${r.ref}`
            : r.result === 'duplicate'
              ? 'Already received'
              : `Credit ${parsed.amount} — no matching order`;
      }
    }

    await Business.updateOne(
      { _id: businessId },
      {
        $set: { 'payments.lastAlertAt': new Date() },
        $push: {
          'payments.recentAlerts': {
            $each: [{ subject: email.subject.slice(0, 140) || '(no subject)', receivedAt: email.receivedAt, outcome }],
            $position: 0,
            $slice: RECENT_ALERTS_KEPT,
          },
        },
      },
    );
    results.push({ token, outcome });
  }
  return results;
};

// ── Mono (linked bank) ───────────────────────────────────────────────────────

const MONO_BASE = 'https://api.withmono.com/v2';
const monoHeaders = () => ({ 'mono-sec-key': process.env.MONO_SECRET_KEY || '', accept: 'application/json', 'content-type': 'application/json' });

const ddmmyyyy = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

const monoError = (e: unknown) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message || (e as Error)?.message || 'Mono request failed';

export const linkMonoAccount = async (businessId: mongoose.Types.ObjectId, code: unknown) => {
  if (!monoConfigured()) throw new AppError('Bank linking is not configured on this server', 503);
  if (typeof code !== 'string' || !code) throw new AppError('Missing Mono code', 400);

  let accountId: string;
  try {
    const auth = await axios.post(`${MONO_BASE}/accounts/auth`, { code }, { headers: monoHeaders() });
    accountId = auth.data?.data?.id ?? auth.data?.id;
    if (!accountId) throw new Error('Mono did not return an account id');
  } catch (e) {
    throw new AppError(`Could not link the bank: ${monoError(e)}`, 502);
  }

  const details: { accountName?: string; accountNumber?: string; institution?: string } = {};
  try {
    const res = await axios.get(`${MONO_BASE}/accounts/${accountId}`, { headers: monoHeaders() });
    const acc = res.data?.data?.account ?? res.data?.data ?? res.data?.account ?? {};
    details.accountName = acc.name ?? acc.account_name;
    const num = String(acc.account_number ?? acc.accountNumber ?? '');
    if (num) details.accountNumber = `••••${num.slice(-4)}`;
    details.institution = acc.institution?.name ?? acc.bank_name;
  } catch {
    /* details are cosmetic */
  }

  await Business.updateOne(
    { _id: businessId },
    { $set: { 'payments.mono': { accountId, ...details, linkedAt: new Date() } } },
  );
  // Pull anything that already arrived for open orders.
  syncMonoForBusiness(businessId).catch(() => {});
  return getPaymentSettings(businessId);
};

export const unlinkMonoAccount = async (businessId: mongoose.Types.ObjectId) => {
  const business = await Business.findById(businessId).select('payments.mono');
  const accountId = business?.payments?.mono?.accountId;
  if (accountId && monoConfigured()) {
    await axios.post(`${MONO_BASE}/accounts/${accountId}/unlink`, {}, { headers: monoHeaders() }).catch(() => {});
  }
  await Business.updateOne({ _id: businessId }, { $unset: { 'payments.mono': 1 } });
  return getPaymentSettings(businessId);
};

/** Pulls recent credits from the linked account and runs them through matching. */
export const syncMonoForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  if (!monoConfigured()) return { synced: 0 };
  const business = await Business.findById(businessId).select('payments.mono');
  const mono = business?.payments?.mono;
  if (!mono?.accountId) return { synced: 0 };

  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  try {
    const res = await axios.get(`${MONO_BASE}/accounts/${mono.accountId}/transactions`, {
      headers: monoHeaders(),
      params: { type: 'credit', start: ddmmyyyy(since), end: ddmmyyyy(new Date()), paginate: false },
    });
    const list: Array<Record<string, unknown>> = res.data?.data?.transactions ?? res.data?.data ?? res.data?.transactions ?? [];
    let synced = 0;
    for (const t of Array.isArray(list) ? list : []) {
      if (String(t.type ?? 'credit').toLowerCase() !== 'credit') continue;
      const id = String(t.id ?? t._id ?? '');
      // Mono reports amounts in kobo.
      const amount = Number(t.amount) / 100;
      if (!id || !(amount > 0)) continue;
      const narration = String(t.narration ?? t.description ?? '');
      const r = await recordCredit(businessId, {
        source: 'mono',
        externalId: id,
        amount,
        narration,
        searchText: narration,
        receivedAt: t.date ? new Date(String(t.date)) : new Date(),
      });
      if (r.result !== 'duplicate') synced += 1;
    }
    await Business.updateOne({ _id: businessId }, { $set: { 'payments.mono.lastSyncedAt': new Date() }, $unset: { 'payments.mono.lastError': 1 } });
    return { synced };
  } catch (e) {
    await Business.updateOne({ _id: businessId }, { $set: { 'payments.mono.lastError': monoError(e).slice(0, 200) } });
    return { synced: 0, error: monoError(e) };
  }
};

// Mono calls this when an account's data changes. Verified with the shared secret.
export const handleMonoWebhook = async (secretHeader: unknown, body: unknown) => {
  const expected = process.env.MONO_WEBHOOK_SECRET;
  if (!expected) throw new AppError('Mono webhooks are not configured', 503);
  if (typeof secretHeader !== 'string' || secretHeader.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(secretHeader), Buffer.from(expected))) {
    throw new AppError('Forbidden', 403);
  }
  const data = (body as { data?: { account?: { _id?: string; id?: string }; id?: string } })?.data;
  const accountId = data?.account?._id ?? data?.account?.id ?? data?.id;
  if (!accountId) return { handled: false };
  const business = await Business.findOne({ 'payments.mono.accountId': String(accountId) }).select('_id');
  if (!business) return { handled: false };
  await syncMonoForBusiness(business._id as mongoose.Types.ObjectId);
  return { handled: true };
};

// Periodic safety net: sync linked accounts that have orders waiting.
export const syncAllLinkedAccounts = async () => {
  if (!monoConfigured()) return;
  const waiting = await Order.distinct('businessId', { status: 'pending_payment' });
  if (waiting.length === 0) return;
  const linked = await Business.find({ _id: { $in: waiting }, 'payments.mono.accountId': { $exists: true } }).select('_id').lean();
  for (const b of linked) await syncMonoForBusiness(b._id as mongoose.Types.ObjectId);
};
