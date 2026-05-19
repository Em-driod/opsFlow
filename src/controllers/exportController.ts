// src/controllers/exportController.ts
// Handles all export/automation API endpoints.

import type { Request, Response } from 'express';
import ExportConfig from '../models/ExportConfig.js';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import Payroll from '../models/Payroll.js';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import {
  initializeSheetTabs,
  batchAppendRows,
  writeSummaryRow,
  transactionToRow,
  clientToRow,
  invoiceToRow,
  payrollToRow,
  SHEET_TABS,
  createSpreadsheet,
} from '../services/googleSheetsService.js';
import { getQueueStats } from '../services/exportQueueService.js';
import crypto from 'crypto';
import axios from 'axios';

// Helper — get or create config for this business
async function getOrCreateConfig(businessId: string) {
  let config = await ExportConfig.findOne({ businessId });
  if (!config) {
    config = await ExportConfig.create({ businessId });
  }
  return config;
}

// @desc   Start Google OAuth2 Consent Flow
// @route  GET /api/export/google/auth
// @access Public (token via query)
export const googleAuthRedirect = async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ message: 'JWT_SECRET missing' });

    let decoded: any;
    try {
      decoded = jwt.verify(token, secret);
    } catch (e) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const user = await User.findById(decoded.id);
    if (!user || !user.businessId) return res.status(401).json({ message: 'User not found or missing businessId' });

    const businessId = String(user.businessId);

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/export/google/callback';

    if (!clientId) return res.status(500).json({ message: 'Server not configured for Google OAuth. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' });

    const state = Buffer.from(businessId).toString('base64');
    const scope = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;

    res.redirect(authUrl);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Google OAuth2 Callback Handler
// @route  GET /api/export/google/callback
// @access Public (validates via state)
export const googleAuthCallback = async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect('http://localhost:3001/automation?error=consent_denied');
    }
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    const businessId = Buffer.from(state as string, 'base64').toString('ascii');

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/export/google/callback';

    const response = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }
    });

    const tokens = response.data;
    
    const config = await getOrCreateConfig(businessId);
    config.googleAccessToken = tokens.access_token;
    config.googleRefreshToken = tokens.refresh_token; 
    config.googleTokenExpiry = Date.now() + (tokens.expires_in * 1000);
    
    await config.save(); 

    const sheetId = await createSpreadsheet(businessId, `OpsFlow Financials - ${new Date().toLocaleDateString()}`);
    await initializeSheetTabs(businessId, sheetId);

    config.googleSheetId = sheetId;
    config.googleSheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    config.sheetsConnected = true;
    config.autoSyncEnabled = true;
    
    await config.save();

    res.redirect('http://localhost:3001/automation?connected=true');

  } catch (err: any) {
    console.error('OAuth Callback Error:', err.response?.data || err.message);
    res.redirect('http://localhost:3001/automation?error=server_error');
  }
};

// @desc   Disconnect Google Sheet
// @route  POST /api/export/disconnect
// @access Private
export const disconnectSheet = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));
    config.sheetsConnected = false;
    config.googleSheetId = '';
    config.googleSheetUrl = '';
    config.googleAccessToken = '';
    config.googleRefreshToken = '';
    config.googleTokenExpiry = 0;
    await config.save();
    res.status(200).json({ message: 'Sheet disconnected successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Get export/automation status
// @route  GET /api/export/status
// @access Private
export const getExportStatus = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));
    const queueStats = getQueueStats();

    res.status(200).json({
      sheetsConnected: config.sheetsConnected,
      googleSheetUrl: config.googleSheetUrl,
      autoSyncEnabled: config.autoSyncEnabled,
      lastFullSyncAt: config.lastFullSyncAt,
      webhookCount: config.webhooks?.length ?? 0,
      recentEvents: config.syncEvents.slice(-20).reverse(),
      queue: queueStats,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Toggle auto-sync on/off
// @route  POST /api/export/toggle-sync
// @access Private
export const toggleAutoSync = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));
    config.autoSyncEnabled = !config.autoSyncEnabled;
    await config.save();
    res.status(200).json({ autoSyncEnabled: config.autoSyncEnabled });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Bulk sync ALL existing historical data to the sheet
// @route  POST /api/export/sync-all
// @access Private
export const syncAllData = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));

    if (!config.sheetsConnected || !config.googleSheetId) {
      return res.status(400).json({ message: 'No Google Sheet connected. Connect a sheet first.' });
    }

    const sheetId = config.googleSheetId;
    const businessId = String(user.businessId);

    // Fetch all records
    const [transactions, clients, invoices, payrolls] = await Promise.all([
      Transaction.find({ businessId }),
      Client.find({ businessId }),
      Invoice.find({ businessId }),
      Payroll.find({ businessId }),
    ]);

    // Batch write all
    const results = await Promise.all([
      batchAppendRows(businessId, sheetId, SHEET_TABS.TRANSACTIONS, transactions.map(transactionToRow)),
      batchAppendRows(businessId, sheetId, SHEET_TABS.CLIENTS, clients.map(clientToRow)),
      batchAppendRows(businessId, sheetId, SHEET_TABS.INVOICES, invoices.map(invoiceToRow)),
      batchAppendRows(businessId, sheetId, SHEET_TABS.PAYROLL, payrolls.map(payrollToRow)),
    ]);

    config.lastFullSyncAt = new Date();
    await config.save();

    res.status(200).json({
      message: '✅ Historical data synced to Google Sheets',
      synced: {
        transactions: transactions.length,
        clients: clients.length,
        invoices: invoices.length,
        payrolls: payrolls.length,
      },
      success: results.every(Boolean),
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Register a new webhook
// @route  POST /api/export/webhooks
// @access Private
export const registerWebhook = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { url, events } = req.body;

    if (!url || !events?.length) {
      return res.status(400).json({ message: 'url and events[] are required' });
    }

    const config = await getOrCreateConfig(String(user.businessId));
    const newWebhook = {
      id: crypto.randomUUID(),
      url,
      events,
      secret: crypto.randomBytes(24).toString('hex'),
      active: true,
      failureCount: 0,
    };

    config.webhooks.push(newWebhook);
    await config.save();

    res.status(201).json({ message: 'Webhook registered', webhook: newWebhook });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   List all webhooks
// @route  GET /api/export/webhooks
// @access Private
export const listWebhooks = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));
    res.status(200).json(config.webhooks ?? []);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Delete a webhook
// @route  DELETE /api/export/webhooks/:id
// @access Private
export const deleteWebhook = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));
    config.webhooks = config.webhooks.filter((wh: any) => wh.id !== req.params.id);
    await config.save();
    res.status(200).json({ message: 'Webhook deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Send a test webhook event
// @route  POST /api/export/webhooks/:id/test
// @access Private
export const testWebhook = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));
    const wh = config.webhooks.find((w: any) => w.id === req.params.id);
    if (!wh) return res.status(404).json({ message: 'Webhook not found' });

    const testPayload = {
      event: 'test.ping',
      timestamp: new Date().toISOString(),
      businessId: String(user.businessId),
      data: { message: 'This is a test event from OpsFlow 🚀' },
    };

    const body = JSON.stringify(testPayload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (wh.secret) {
      const sig = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
      headers['X-OpsFlow-Signature'] = `sha256=${sig}`;
    }

    const fetchRes = await fetch(wh.url, { method: 'POST', headers, body });
    res.status(200).json({ delivered: fetchRes.ok, status: fetchRes.status });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};

// @desc   Write nightly summary to the summary tab (called by cron)
// @route  POST /api/export/summary (internal or admin only)
// @access Private
export const writeDailySummary = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const config = await getOrCreateConfig(String(user.businessId));
    if (!config.sheetsConnected || !config.googleSheetId) {
      return res.status(400).json({ message: 'No sheet connected' });
    }

    const businessId = String(user.businessId);
    const [incomeAgg, expenseAgg, clients, invoices] = await Promise.all([
      Transaction.aggregate([{ $match: { businessId, type: 'income' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { businessId, type: 'expense' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Client.countDocuments({ businessId }),
      Invoice.find({ businessId }),
    ]);

    const totalIncome = incomeAgg[0]?.total ?? 0;
    const totalExpenses = expenseAgg[0]?.total ?? 0;

    await writeSummaryRow(businessId, config.googleSheetId, {
      date: new Date().toLocaleDateString(),
      totalIncome,
      totalExpenses,
      netProfit: totalIncome - totalExpenses,
      totalClients: clients,
      pendingInvoices: invoices.filter((i: any) => i.status === 'sent' || i.status === 'overdue').length,
      paidInvoices: invoices.filter((i: any) => i.status === 'paid').length,
    });

    res.status(200).json({ message: '📊 Summary written to sheet' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: (err as Error).message });
  }
};
