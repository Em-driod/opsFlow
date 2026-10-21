import mongoose from 'mongoose';
import crypto from 'crypto';
import Order, { type IOrder, type OrderStage, type OrderStatus, type PaymentSource } from '../models/Order.js';
import Business from '../models/Business.js';
import Product from '../models/Product.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import { createReceiptForBusiness } from './receiptService.js';
import { createNotification } from './notificationService.js';
import { emitToBusiness } from './socketService.js';
import { sendIssuedReceiptEmail, sendOrderUpdateEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';
import { isDuplicateKeyError } from '../utils/transaction.js';
import { escapeRegex } from '../utils/regex.js';
import { logoUrlForEmail } from '../utils/branding.js';
import type { IUser } from '../models/User.js';

// ─────────────────────────────────────────────────────────────────────────────
// Online orders from the public business page.
//
// The customer pays by bank transfer straight into the business's own account
// — Morniy never holds the money. Every order gets a short code (e.g.
// "MR7K4Q2P") for the transfer narration. The order is marked paid by:
//   • a forwarded bank alert email that matches it  (bankFeedService)
//   • a linked bank feed (Mono) that matches it       (bankFeedService)
//   • the owner tapping "Confirm payment"
// All three go through markOrderPaid(), which records the income, issues the
// receipt (reducing stock and capturing cost for the profit report) and lets
// the owner and customer know.
// ─────────────────────────────────────────────────────────────────────────────

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read aloud and type
const MAX_QTY = 999;
const MAX_LINES = 50;

const roundMoney = (n: number) => Math.round(n * 100) / 100;

const generateCode = async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.randomBytes(6);
    const code = 'MR' + Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!(await Order.exists({ code }))) return code;
  }
  throw new AppError('Could not create an order number, please try again', 500);
};

const hasBankAccount = (profile?: { accountNumber?: string; accountNumber2?: string }) =>
  !!(profile?.accountNumber || profile?.accountNumber2);

export const isOrderingOpen = (business: { payments?: { ordersEnabled?: boolean } | null; profile?: { accountNumber?: string; accountNumber2?: string } }) =>
  !!business.payments?.ordersEnabled && hasBankAccount(business.profile);

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ── Public ───────────────────────────────────────────────────────────────────

export const createPublicOrder = async (slug: string, body: Record<string, unknown>) => {
  const business = await Business.findOne({ slug }).select('name currency owner profile payments');
  if (!business || !business.profile?.isPublic) throw new AppError('Business not found', 404);
  if (!isOrderingOpen(business)) throw new AppError('This business is not taking online orders right now', 400);

  const name = clean(body.name, 80);
  const phone = clean(body.phone, 30);
  const email = clean(body.email, 120).toLowerCase();
  const address = clean(body.address, 300);
  const note = clean(body.note, 500);
  const deliveryMethod = body.deliveryMethod === 'delivery' ? 'delivery' : 'pickup';

  if (name.length < 2) throw new AppError('Please enter your name', 400);
  if (phone.replace(/\D/g, '').length < 7) throw new AppError('Please enter a valid phone number', 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Please enter a valid email address', 400);
  if (deliveryMethod === 'delivery' && address.length < 5) throw new AppError('Please enter a delivery address', 400);

  // Merge duplicate lines and validate quantities.
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const wanted = new Map<string, number>();
  for (const raw of rawItems.slice(0, MAX_LINES)) {
    const it = raw as { productId?: unknown; quantity?: unknown };
    const id = String(it.productId ?? '');
    const qty = Math.floor(Number(it.quantity));
    if (!mongoose.isValidObjectId(id) || !Number.isFinite(qty) || qty < 1) continue;
    wanted.set(id, Math.min(MAX_QTY, (wanted.get(id) ?? 0) + qty));
  }
  if (wanted.size === 0) throw new AppError('Your cart is empty', 400);

  // Prices always come from the catalog, never from the browser.
  const products = await Product.find({
    _id: { $in: [...wanted.keys()] },
    businessId: business._id,
    isActive: true,
    showOnProfile: { $ne: false },
  }).lean();
  if (products.length !== wanted.size) throw new AppError('Some items are no longer available — please refresh the page', 409);

  const items = products.map((p) => {
    const quantity = wanted.get(String(p._id))!;
    if (p.trackStock && (p.stock ?? 0) < quantity) {
      const left = Math.max(0, p.stock ?? 0);
      throw new AppError(left > 0 ? `Only ${left} ${p.name} left in stock` : `${p.name} is out of stock`, 409);
    }
    return {
      productId: p._id,
      name: p.name,
      unitPrice: roundMoney(p.price),
      quantity,
      total: roundMoney(p.price * quantity),
    };
  });
  const subtotal = roundMoney(items.reduce((s, i) => s + i.total, 0));
  if (subtotal <= 0) throw new AppError('This order has no amount to pay', 400);

  const order = await Order.create({
    businessId: business._id,
    code: await generateCode(),
    publicToken: crypto.randomBytes(20).toString('hex'),
    items,
    subtotal,
    total: subtotal,
    currency: business.currency || 'NGN',
    customer: { name, phone, ...(email ? { email } : {}), ...(address ? { address } : {}) },
    deliveryMethod,
    ...(note ? { note } : {}),
  });

  await notifyAdmins(business._id as mongoose.Types.ObjectId, business.owner, {
    message: `New order ${order.code} from ${name} — ${formatMoney(order.total, order.currency)}, awaiting payment.`,
    link: `/orders?open=${order._id}`,
  });
  emitToBusiness(String(business._id), 'data_updated', { type: 'order', action: 'created' });

  return toPublicView(order, business);
};

const toPublicView = (
  order: IOrder,
  business: {
    name: string;
    slug?: string | undefined;
    profile?: {
      logoImage?: string; accentColor?: string; whatsapp?: string; email?: string;
      bankName?: string; accountNumber?: string; accountName?: string;
      bankName2?: string; accountNumber2?: string; accountName2?: string;
    };
  },
  receiptToken?: string | null,
) => {
  const p = business.profile ?? {};
  const awaiting = order.status === 'pending_payment';
  const accounts = [
    { bankName: p.bankName, accountNumber: p.accountNumber, accountName: p.accountName },
    { bankName: p.bankName2, accountNumber: p.accountNumber2, accountName: p.accountName2 },
  ].filter((a) => a.accountNumber);
  return {
    code: order.code,
    token: order.publicToken,
    status: order.status,
    items: order.items.map((i) => ({ name: i.name, unitPrice: i.unitPrice, quantity: i.quantity, total: i.total })),
    subtotal: order.subtotal,
    total: order.total,
    currency: order.currency,
    customerName: order.customer.name,
    deliveryMethod: order.deliveryMethod,
    createdAt: order.createdAt,
    paidAt: order.paidAt ?? null,
    customerMarkedPaidAt: order.customerMarkedPaidAt ?? null,
    receiptToken: receiptToken ?? null,
    stage: currentStage(order),
    progress: progressOf(order).map((p) => ({ stage: p.stage, at: p.at, ...(p.note ? { note: p.note } : {}) })),
    business: {
      name: business.name,
      slug: business.slug ?? null,
      logoImage: p.logoImage || null,
      accentColor: p.accentColor || '#6366f1',
      whatsapp: p.whatsapp || null,
      email: p.email || null,
    },
    // Bank details only while there's something to pay.
    payTo: awaiting ? accounts : [],
  };
};

export const getPublicOrder = async (token: string) => {
  const order = await Order.findOne({ publicToken: token });
  if (!order) throw new AppError('Order not found', 404);
  const business = await Business.findById(order.businessId).select('name slug profile').lean();
  if (!business) throw new AppError('Order not found', 404);
  let receiptToken: string | null = null;
  if (order.receiptId) {
    const receipt = await mongoose.model('Receipt').findById(order.receiptId).select('publicToken').lean<{ publicToken?: string }>();
    receiptToken = receipt?.publicToken ?? null;
  }
  return toPublicView(order, business as never, receiptToken);
};

// "I've sent the money" — not proof of payment, just a nudge to the owner to
// check, in case the automatic match didn't catch it.
export const markSentByCustomer = async (token: string) => {
  const order = await Order.findOne({ publicToken: token });
  if (!order) throw new AppError('Order not found', 404);
  if (order.status !== 'pending_payment' || order.customerMarkedPaidAt) return getPublicOrder(token);

  order.customerMarkedPaidAt = new Date();
  await order.save();
  const business = await Business.findById(order.businessId).select('owner');
  await notifyAdmins(order.businessId, business?.owner, {
    message: `${order.customer.name} says they've paid ${formatMoney(order.total, order.currency)} for order ${order.code}. Check your account and confirm.`,
    link: `/orders?open=${order._id}`,
  });
  emitToBusiness(String(order.businessId), 'data_updated', { type: 'order', action: 'updated' });
  return getPublicOrder(token);
};

// ── Owner ────────────────────────────────────────────────────────────────────

export const listOrders = async (
  businessId: mongoose.Types.ObjectId,
  params: { status?: string; q?: string; page?: string; limit?: string },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (params.status && ['pending_payment', 'paid', 'fulfilled', 'cancelled'].includes(params.status)) filter.status = params.status;
  if (params.q?.trim()) {
    const rx = new RegExp(escapeRegex(params.q.trim()), 'i');
    filter.$or = [{ code: rx }, { 'customer.name': rx }, { 'customer.phone': rx }, { 'customer.email': rx }];
  }
  const page = Math.max(1, parseInt(params.page || '1') || 1);
  const limit = Math.min(100, Math.max(1, parseInt(params.limit || '30') || 30));

  const [data, total, countsRaw] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
    Order.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(String(businessId)) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const counts = { pending_payment: 0, paid: 0, fulfilled: 0, cancelled: 0 } as Record<OrderStatus, number>;
  for (const c of countsRaw) counts[c._id as OrderStatus] = c.n;

  return { data, total, page, pages: Math.max(1, Math.ceil(total / limit)), counts };
};

export const getOrder = async (id: string, businessId: mongoose.Types.ObjectId) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Order not found', 404);
  const order = await Order.findOne({ _id: id, businessId }).lean();
  if (!order) throw new AppError('Order not found', 404);
  const receipt = order.receiptId
    ? await mongoose.model('Receipt').findById(order.receiptId).select('receiptNumber publicToken').lean<{ receiptNumber?: string; publicToken?: string }>()
    : null;
  return {
    ...order,
    receipt,
    progress: progressOf(order as IOrder),
    stage: currentStage(order as IOrder),
    nextStages: order.status === 'paid'
      ? stagesFor(order.deliveryMethod).filter((s) => STAGE_ORDER[s] > STAGE_ORDER[currentStage(order as IOrder)])
      : [],
  };
};

export const confirmPaymentByOwner = async (id: string, user: IUser) => {
  const order = await Order.findOne({ _id: id, businessId: user.businessId });
  if (!order) throw new AppError('Order not found', 404);
  if (order.status !== 'pending_payment') throw new AppError('This order is not awaiting payment', 400);
  const paid = await markOrderPaid(order._id as mongoose.Types.ObjectId, {
    source: 'manual',
    matchedBy: 'manual',
    amount: order.total,
    user,
  });
  if (!paid) throw new AppError('This order is not awaiting payment', 400);
  return getOrder(id, user.businessId);
};

export const updateOrderStatus = async (id: string, businessId: mongoose.Types.ObjectId, status: string) => {
  const order = await Order.findOne({ _id: id, businessId });
  if (!order) throw new AppError('Order not found', 404);

  if (status === 'fulfilled') {
    return advanceOrderStage(id, businessId, { stage: 'completed' });
  } else if (status === 'paid' && order.status === 'fulfilled') {
    return undoOrderStage(id, businessId);
  } else if (status === 'cancelled') {
    if (order.status !== 'pending_payment') {
      throw new AppError('Paid orders can’t be cancelled here — refund the customer and delete the receipt instead', 400);
    }
    order.status = 'cancelled';
    order.cancelledAt = new Date();
    order.progress = [...progressOf(order), { stage: 'cancelled', at: order.cancelledAt }];
  } else {
    throw new AppError('Unsupported status change', 400);
  }

  await order.save();
  emitToBusiness(String(businessId), 'data_updated', { type: 'order', action: 'updated' });
  return getOrder(id, businessId);
};

// ── Progress (what the customer sees after paying) ───────────────────────────

const STAGE_ORDER: Record<OrderStage, number> = {
  placed: 0, paid: 1, preparing: 2, ready: 3, out_for_delivery: 3, completed: 4, cancelled: 5,
};

// Orders saved before progress tracking existed have no history; rebuild a
// sensible one from their status so they still display properly.
const progressOf = (order: Pick<IOrder, 'progress' | 'status' | 'createdAt' | 'paidAt' | 'fulfilledAt' | 'cancelledAt'>) => {
  if (order.progress?.length) {
    return order.progress[0]!.stage === 'placed' ? order.progress : [{ stage: 'placed' as OrderStage, at: order.createdAt }, ...order.progress];
  }
  const out: { stage: OrderStage; at: Date; note?: string }[] = [{ stage: 'placed', at: order.createdAt }];
  if (order.paidAt) out.push({ stage: 'paid', at: order.paidAt });
  if (order.status === 'fulfilled') out.push({ stage: 'completed', at: order.fulfilledAt ?? order.paidAt ?? order.createdAt });
  if (order.status === 'cancelled') out.push({ stage: 'cancelled', at: order.cancelledAt ?? order.createdAt });
  return out;
};

const currentStage = (order: Parameters<typeof progressOf>[0]): OrderStage => progressOf(order).at(-1)!.stage;

// Which steps make sense for this order: pickup orders get "ready", delivery
// orders get "out for delivery".
export const stagesFor = (deliveryMethod: 'pickup' | 'delivery'): OrderStage[] =>
  deliveryMethod === 'delivery' ? ['preparing', 'out_for_delivery', 'completed'] : ['preparing', 'ready', 'completed'];

const STAGE_COPY = (stage: OrderStage, pickup: boolean, business: string) =>
  ({
    preparing: { headline: 'Your order is being prepared', message: `${business} has started getting your order ready.` },
    ready: { headline: 'Your order is ready for pickup', message: `Your order is ready. You can pick it up from ${business} now.` },
    out_for_delivery: { headline: 'Your order is on its way', message: `Your order has left ${business} and is on its way to you.` },
    completed: pickup
      ? { headline: 'Order picked up — thank you!', message: `Thanks for shopping with ${business}. We hope to see you again.` }
      : { headline: 'Order delivered — thank you!', message: `Your order has been delivered. Thanks for shopping with ${business}.` },
  }) as Partial<Record<OrderStage, { headline: string; message: string }>>;

export const advanceOrderStage = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  params: { stage: unknown; note?: unknown; notify?: unknown },
) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Order not found', 404);
  const order = await Order.findOne({ _id: id, businessId });
  if (!order) throw new AppError('Order not found', 404);
  if (order.status !== 'paid') {
    throw new AppError(order.status === 'fulfilled' ? 'This order is already complete' : 'Confirm payment before updating the order', 400);
  }

  const stage = String(params.stage) as OrderStage;
  const allowed = stagesFor(order.deliveryMethod);
  if (!allowed.includes(stage)) {
    throw new AppError(order.deliveryMethod === 'delivery' ? 'Use “Out for delivery” for delivery orders' : 'Use “Ready for pickup” for pickup orders', 400);
  }
  const current = currentStage(order);
  if (STAGE_ORDER[stage] <= STAGE_ORDER[current]) throw new AppError('This order is already past that step', 400);

  const note = typeof params.note === 'string' ? params.note.trim().slice(0, 300) : '';
  const at = new Date();
  order.progress = [...progressOf(order), { stage, at, ...(note ? { note } : {}) }];
  if (stage === 'completed') {
    order.status = 'fulfilled';
    order.fulfilledAt = at;
  }
  await order.save();
  emitToBusiness(String(businessId), 'data_updated', { type: 'order', action: 'updated' });

  // Let the customer know, unless the owner chose not to.
  if (order.customer.email && params.notify !== false) {
    const business = await Business.findById(businessId).select('name profile.logoImage profile.accentColor updatedAt').lean();
    const copy = STAGE_COPY(stage, order.deliveryMethod === 'pickup', business?.name || 'The business')[stage];
    if (business && copy) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      sendOrderUpdateEmail({
        recipientEmail: order.customer.email,
        customerName: order.customer.name,
        businessName: business.name,
        orderCode: order.code,
        headline: copy.headline,
        message: copy.message,
        note: note || undefined,
        trackLink: `${frontendUrl}/order/${order.publicToken}`,
        logoUrl: logoUrlForEmail(business as never),
        accentColor: business.profile?.accentColor,
      }).catch(() => {});
    }
  }

  return getOrder(id, businessId);
};

// Steps back one stage after a mis-tap. Payment itself can't be undone here.
export const undoOrderStage = async (id: string, businessId: mongoose.Types.ObjectId) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Order not found', 404);
  const order = await Order.findOne({ _id: id, businessId });
  if (!order) throw new AppError('Order not found', 404);
  const progress = [...progressOf(order)];
  const last = progress.at(-1)!;
  if (!['preparing', 'ready', 'out_for_delivery', 'completed'].includes(last.stage)) {
    throw new AppError('There’s no step to undo', 400);
  }
  progress.pop();
  order.progress = progress;
  if (last.stage === 'completed') {
    order.status = 'paid';
    order.set('fulfilledAt', undefined);
  }
  await order.save();
  emitToBusiness(String(businessId), 'data_updated', { type: 'order', action: 'updated' });
  return getOrder(id, businessId);
};

// ── Shared ───────────────────────────────────────────────────────────────────

const formatMoney = (amount: number, currency = 'NGN') => {
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
};

const notifyAdmins = async (
  businessId: mongoose.Types.ObjectId,
  ownerId: mongoose.Types.ObjectId | undefined,
  payload: { message: string; link: string },
) => {
  const admins = await User.find({ businessId, role: 'admin' }).select('_id').lean();
  const ids = new Set(admins.map((a) => String(a._id)));
  if (ownerId) ids.add(String(ownerId));
  await Promise.all(
    [...ids].map((userId) =>
      createNotification({ businessId, userId: new mongoose.Types.ObjectId(userId), ...payload }),
    ),
  );
};

/**
 * Marks an awaiting order as paid and does everything that follows. Safe to
 * call concurrently or repeatedly: only the call that flips the status from
 * pending_payment wins; every other call returns null and does nothing.
 */
export const markOrderPaid = async (
  orderId: mongoose.Types.ObjectId,
  opts: {
    source: PaymentSource;
    matchedBy: 'code' | 'amount' | 'manual';
    amount: number;
    bankCreditId?: mongoose.Types.ObjectId;
    user?: IUser;
    paidAt?: Date;
  },
): Promise<IOrder | null> => {
  const paidAt = opts.paidAt ?? new Date();
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: 'pending_payment' },
    {
      $set: {
        status: 'paid',
        paidAt,
        paidAmount: roundMoney(opts.amount),
        paymentSource: opts.source,
        matchedBy: opts.matchedBy,
        ...(opts.bankCreditId ? { bankCreditId: opts.bankCreditId } : {}),
        ...(opts.user ? { confirmedBy: opts.user._id } : {}),
      },
      $push: { progress: { stage: 'paid', at: paidAt } },
    },
    { new: true },
  );
  if (!order) return null;

  const business = await Business.findById(order.businessId).select('name currency owner profile.logoImage profile.accentColor updatedAt');
  const recorder =
    (opts.user?._id as mongoose.Types.ObjectId | undefined) ??
    business?.owner ??
    ((await User.findOne({ businessId: order.businessId, role: 'admin' }).select('_id').lean())?._id as mongoose.Types.ObjectId | undefined);

  // Income transaction — one per order, guaranteed by the unique external id.
  let transactionId: mongoose.Types.ObjectId | undefined;
  try {
    const tx = await Transaction.create({
      businessId: order.businessId,
      amount: order.total,
      type: 'income',
      category: 'Sales',
      description: `Order ${order.code} — ${order.customer.name}`,
      date: paidAt,
      recordedBy: recorder,
      source: opts.source === 'manual' ? 'manual' : 'bank_sync',
      externalSource: 'order',
      externalId: String(order._id),
    });
    transactionId = tx._id as mongoose.Types.ObjectId;
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    transactionId = (await Transaction.findOne({ businessId: order.businessId, externalSource: 'order', externalId: String(order._id) }).select('_id').lean())
      ?._id as mongoose.Types.ObjectId | undefined;
  }

  // Receipt — reduces stock and snapshots cost for the profit report.
  const receipt = await createReceiptForBusiness(order.businessId, {
    payerName: order.customer.name,
    ...(order.customer.email ? { payerEmail: order.customer.email } : {}),
    payerPhone: order.customer.phone,
    items: order.items.map((i) => ({
      description: i.quantity > 1 ? `${i.name} x${i.quantity}` : i.name,
      amount: i.total,
      productId: i.productId,
      quantity: i.quantity,
      ...(transactionId ? { transactionId } : {}),
    })),
    transactionIds: transactionId ? [transactionId] : [],
    description: `Order ${order.code}`,
    currency: order.currency,
    date: paidAt,
    notes: order.deliveryMethod === 'delivery' ? `Delivery to: ${order.customer.address ?? ''}` : 'Pickup',
  });

  if (transactionId) order.transactionId = transactionId;
  order.receiptId = receipt._id as mongoose.Types.ObjectId;
  await order.save();

  const how =
    opts.source === 'manual' ? 'confirmed by you' : opts.source === 'mono' ? 'matched from your linked bank' : 'matched from your bank alert';
  await notifyAdmins(order.businessId, business?.owner, {
    message: `Order ${order.code} paid — ${formatMoney(order.total, order.currency)} from ${order.customer.name} (${how}).`,
    link: `/orders?open=${order._id}`,
  });
  emitToBusiness(String(order.businessId), 'data_updated', { type: 'order', action: 'paid' });

  if (order.customer.email && business) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    sendIssuedReceiptEmail({
      recipientEmail: order.customer.email,
      payerName: order.customer.name,
      businessName: business.name,
      receiptNumber: receipt.receiptNumber,
      amount: receipt.amount,
      currency: order.currency,
      description: `Order ${order.code}`,
      date: paidAt.toISOString(),
      publicLink: `${frontendUrl}/receipt/${receipt.publicToken}`,
      logoUrl: logoUrlForEmail(business),
      accentColor: business.profile?.accentColor,
    }).catch(() => {});
  }

  return order;
};
