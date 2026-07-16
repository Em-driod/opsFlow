// src/controllers/exportController.ts
// Handles all export/automation API endpoints.

import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as exportService from '../services/exportService.js';

// @desc   Start Google OAuth2 Consent Flow
// @route  GET /api/export/google/auth
// @access Public (token via query)
export const googleAuthRedirect = asyncHandler(async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) throw new AppError('No token provided', 401);
  const authUrl = await exportService.buildGoogleAuthUrl(token);
  res.redirect(authUrl);
});

// @desc   Google OAuth2 Callback Handler
// @route  GET /api/export/google/callback
// @access Public (validates via state)
export const googleAuthCallback = async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

  try {
    if (error) {
      return res.redirect(`${frontendUrl}/#/automation?error=consent_denied`);
    }
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    await exportService.completeGoogleAuthCallback(code as string, state as string);

    res.redirect(`${frontendUrl}/#/automation?connected=true`);
  } catch (err) {
    console.error('OAuth Callback Error:', (err as { response?: { data?: unknown } }).response?.data || (err as Error).message);
    res.redirect(`${frontendUrl}/#/automation?error=server_error`);
  }
};

// @desc   Disconnect Google Sheet
// @route  POST /api/export/disconnect
// @access Private
export const disconnectSheet = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await exportService.disconnectSheetForBusiness(req.user.businessId);
  res.status(200).json({ message: 'Sheet disconnected successfully' });
});

// @desc   Get export/automation status
// @route  GET /api/export/status
// @access Private
export const getExportStatus = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const status = await exportService.getExportStatusForBusiness(req.user.businessId);
  res.status(200).json(status);
});

// @desc   Toggle auto-sync on/off
// @route  POST /api/export/toggle-sync
// @access Private
export const toggleAutoSync = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const autoSyncEnabled = await exportService.toggleAutoSyncForBusiness(req.user.businessId);
  res.status(200).json({ autoSyncEnabled });
});

// @desc   Bulk sync ALL existing historical data to the sheet
// @route  POST /api/export/sync-all
// @access Private
export const syncAllData = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { synced, success } = await exportService.syncAllDataForBusiness(req.user);
  res.status(200).json({ message: '✅ Historical data synced to Google Sheets', synced, success });
});

// @desc   Register a new webhook
// @route  POST /api/export/webhooks
// @access Private
export const registerWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { url, events } = req.body;
  const webhook = await exportService.registerWebhookForBusiness(req.user.businessId, url, events);
  res.status(201).json({ message: 'Webhook registered', webhook });
});

// @desc   List all webhooks
// @route  GET /api/export/webhooks
// @access Private
export const listWebhooks = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const webhooks = await exportService.listWebhooksForBusiness(req.user.businessId);
  res.status(200).json(webhooks);
});

// @desc   Delete a webhook
// @route  DELETE /api/export/webhooks/:id
// @access Private
export const deleteWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await exportService.deleteWebhookForBusiness(req.user.businessId, req.params.id!);
  res.status(200).json({ message: 'Webhook deleted' });
});

// @desc   Send a test webhook event
// @route  POST /api/export/webhooks/:id/test
// @access Private
export const testWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await exportService.testWebhookForBusiness(req.user.businessId, req.params.id!);
  res.status(200).json(result);
});

// @desc   Write nightly summary to the summary tab (called by cron)
// @route  POST /api/export/summary (internal or admin only)
// @access Private
export const writeDailySummary = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await exportService.writeDailySummaryForBusiness(req.user);
  res.status(200).json({ message: '📊 Summary written to sheet' });
});
