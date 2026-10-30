import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as orderService from '../services/orderService.js';
import * as bankFeedService from '../services/bankFeedService.js';

// ── Public (customer) ────────────────────────────────────────────────────────

// POST /api/orders/public/:slug
export const placeOrder = asyncHandler(async (req: Request, res: Response) => {
  const order = await orderService.createPublicOrder(req.params.slug!, req.body ?? {});
  res.status(201).json(order);
});

// GET /api/orders/public/track/:token
export const trackOrder = asyncHandler(async (req: Request, res: Response) => {
  res.json(await orderService.getPublicOrder(req.params.token!));
});

// POST /api/orders/public/track/:token/sent
export const markSent = asyncHandler(async (req: Request, res: Response) => {
  res.json(await orderService.markSentByCustomer(req.params.token!));
});

// ── Owner ────────────────────────────────────────────────────────────────────

// GET /api/orders
export const listOrders = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { status, q, page, limit } = req.query as Record<string, string | undefined>;
  res.json(
    await orderService.listOrders(req.user.businessId, {
      ...(status ? { status } : {}),
      ...(q ? { q } : {}),
      ...(page ? { page } : {}),
      ...(limit ? { limit } : {}),
    }),
  );
});

// GET /api/orders/:id
export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await orderService.getOrder(req.params.id!, req.user.businessId));
});

// POST /api/orders/:id/confirm-payment
export const confirmPayment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await orderService.confirmPaymentByOwner(req.params.id!, req.user));
});

// PUT /api/orders/:id/status
export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await orderService.updateOrderStatus(req.params.id!, req.user.businessId, String(req.body?.status ?? '')));
});

// PUT /api/orders/:id/stage  { stage, note?, notify? }
export const advanceStage = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await orderService.advanceOrderStage(req.params.id!, req.user.businessId, req.body ?? {}));
});

// POST /api/orders/:id/stage/undo
export const undoStage = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await orderService.undoOrderStage(req.params.id!, req.user.businessId));
});

// ── Payment detection settings ───────────────────────────────────────────────

// GET /api/payments/settings
export const getPaymentSettings = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await bankFeedService.getPaymentSettings(req.user.businessId));
});

// PUT /api/payments/settings
export const updatePaymentSettings = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await bankFeedService.updatePaymentSettings(req.user.businessId, req.body ?? {}));
});

// GET /api/payments/credits?status=unmatched
export const listCredits = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await bankFeedService.listCredits(req.user.businessId, req.query.status as string | undefined));
});

// POST /api/payments/credits/:id/match  { orderId }
export const matchCredit = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  // Either an order or an invoice can be picked as the match.
  if (req.body?.invoiceId) {
    res.json(await bankFeedService.matchCreditToInvoice(req.params.id!, String(req.body.invoiceId), req.user));
    return;
  }
  res.json(await bankFeedService.matchCreditToOrder(req.params.id!, String(req.body?.orderId ?? ''), req.user));
});

// POST /api/payments/credits/:id/dismiss
export const dismissCredit = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await bankFeedService.dismissCredit(req.params.id!, req.user.businessId));
});

// POST /api/payments/mono/link  { code }
export const linkMono = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await bankFeedService.linkMonoAccount(req.user.businessId, req.body?.code));
});

// DELETE /api/payments/mono
export const unlinkMono = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await bankFeedService.unlinkMonoAccount(req.user.businessId));
});

// POST /api/payments/mono/sync
export const syncMono = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  res.json(await bankFeedService.syncMonoForBusiness(req.user.businessId));
});

// ── Webhooks ─────────────────────────────────────────────────────────────────

// POST /api/payments/webhooks/email?secret=...
// Always 200 for a valid secret so the email service doesn't retry forever.
export const inboundEmailWebhook = asyncHandler(async (req: Request, res: Response) => {
  const results = await bankFeedService.handleInboundEmail(req.query.secret, req.rawBody, req.body);
  res.status(200).json({ received: true, results });
});

// POST /api/payments/webhooks/mono
export const monoWebhook = asyncHandler(async (req: Request, res: Response) => {
  const result = await bankFeedService.handleMonoWebhook(req.headers['mono-webhook-secret'], req.body);
  res.status(200).json({ received: true, ...result });
});
