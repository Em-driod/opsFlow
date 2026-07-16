import mongoose from 'mongoose';
import crypto from 'crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import ExportConfig, { type IWebhook } from '../models/ExportConfig.js';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import Payroll from '../models/Payroll.js';
import User from '../models/User.js';
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
} from './googleSheetsService.js';
import { getQueueStats } from './exportQueueService.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

// Helper — get or create config for this business
export async function getOrCreateConfig(businessId: string) {
  let config = await ExportConfig.findOne({ businessId });
  if (!config) {
    config = await ExportConfig.create({ businessId });
  }
  return config;
}

export const buildGoogleAuthUrl = async (token: string) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new AppError('JWT_SECRET missing', 500);

  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, secret) as jwt.JwtPayload;
  } catch {
    throw new AppError('Invalid token', 401);
  }

  const user = await User.findById(decoded.id);
  if (!user || !user.businessId) throw new AppError('User not found or missing businessId', 401);

  const businessId = String(user.businessId);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5000';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${baseUrl}/api/export/google/callback`;

  if (!clientId) {
    throw new AppError('Server not configured for Google OAuth. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 500);
  }

  const state = Buffer.from(businessId).toString('base64');
  const scope = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;
};

export const completeGoogleAuthCallback = async (code: string, state: string) => {
  const businessId = Buffer.from(state, 'base64').toString('ascii');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${frontendUrl}/api/export/google/callback`;

  const response = await axios.post('https://oauth2.googleapis.com/token', null, {
    params: { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' },
  });

  const tokens = response.data;

  const config = await getOrCreateConfig(businessId);
  config.googleAccessToken = tokens.access_token;
  config.googleRefreshToken = tokens.refresh_token;
  config.googleTokenExpiry = Date.now() + tokens.expires_in * 1000;
  await config.save();

  const sheetId = await createSpreadsheet(businessId, `OpsFlow Financials - ${new Date().toLocaleDateString()}`);
  await initializeSheetTabs(businessId, sheetId);

  config.googleSheetId = sheetId;
  config.googleSheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  config.sheetsConnected = true;
  config.autoSyncEnabled = true;
  await config.save();
};

export const disconnectSheetForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const config = await getOrCreateConfig(String(businessId));
  config.sheetsConnected = false;
  config.googleSheetId = '';
  config.googleSheetUrl = '';
  config.googleAccessToken = '';
  config.googleRefreshToken = '';
  config.googleTokenExpiry = 0;
  await config.save();
};

export const getExportStatusForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const config = await getOrCreateConfig(String(businessId));
  const queueStats = getQueueStats();

  return {
    sheetsConnected: config.sheetsConnected,
    googleSheetUrl: config.googleSheetUrl,
    autoSyncEnabled: config.autoSyncEnabled,
    lastFullSyncAt: config.lastFullSyncAt,
    webhookCount: config.webhooks?.length ?? 0,
    recentEvents: config.syncEvents.slice(-20).reverse(),
    queue: queueStats,
  };
};

export const toggleAutoSyncForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const config = await getOrCreateConfig(String(businessId));
  config.autoSyncEnabled = !config.autoSyncEnabled;
  await config.save();
  return config.autoSyncEnabled;
};

export const syncAllDataForBusiness = async (user: IUser) => {
  const config = await getOrCreateConfig(String(user.businessId));
  if (!config.sheetsConnected || !config.googleSheetId) {
    throw new AppError('No Google Sheet connected. Connect a sheet first.', 400);
  }

  const sheetId = config.googleSheetId;
  const businessId = String(user.businessId);

  const [transactions, clients, invoices, payrolls] = await Promise.all([
    Transaction.find({ businessId }),
    Client.find({ businessId }),
    Invoice.find({ businessId }),
    Payroll.find({ businessId }),
  ]);

  const results = await Promise.all([
    batchAppendRows(businessId, sheetId, SHEET_TABS.TRANSACTIONS, transactions.map(transactionToRow)),
    batchAppendRows(businessId, sheetId, SHEET_TABS.CLIENTS, clients.map(clientToRow)),
    batchAppendRows(businessId, sheetId, SHEET_TABS.INVOICES, invoices.map(invoiceToRow)),
    batchAppendRows(businessId, sheetId, SHEET_TABS.PAYROLL, payrolls.map(payrollToRow)),
  ]);

  config.lastFullSyncAt = new Date();
  await config.save();

  return {
    synced: { transactions: transactions.length, clients: clients.length, invoices: invoices.length, payrolls: payrolls.length },
    success: results.every(Boolean),
  };
};

export const registerWebhookForBusiness = async (businessId: mongoose.Types.ObjectId, url: string, events: string[]) => {
  if (!url || !events?.length) throw new AppError('url and events[] are required', 400);

  const config = await getOrCreateConfig(String(businessId));
  const newWebhook: IWebhook = {
    id: crypto.randomUUID(),
    url,
    events,
    secret: crypto.randomBytes(24).toString('hex'),
    active: true,
    failureCount: 0,
  };

  config.webhooks.push(newWebhook);
  await config.save();

  return newWebhook;
};

export const listWebhooksForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  const config = await getOrCreateConfig(String(businessId));
  return config.webhooks ?? [];
};

export const deleteWebhookForBusiness = async (businessId: mongoose.Types.ObjectId, webhookId: string) => {
  const config = await getOrCreateConfig(String(businessId));
  config.webhooks = config.webhooks.filter((wh) => wh.id !== webhookId);
  await config.save();
};

export const testWebhookForBusiness = async (businessId: mongoose.Types.ObjectId, webhookId: string) => {
  const config = await getOrCreateConfig(String(businessId));
  const wh = config.webhooks.find((w) => w.id === webhookId);
  if (!wh) throw new AppError('Webhook not found', 404);

  const testPayload = {
    event: 'test.ping',
    timestamp: new Date().toISOString(),
    businessId: String(businessId),
    data: { message: 'This is a test event from OpsFlow 🚀' },
  };

  const body = JSON.stringify(testPayload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (wh.secret) {
    const sig = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
    headers['X-OpsFlow-Signature'] = `sha256=${sig}`;
  }

  const fetchRes = await fetch(wh.url, { method: 'POST', headers, body });
  return { delivered: fetchRes.ok, status: fetchRes.status };
};

export const writeDailySummaryForBusiness = async (user: IUser) => {
  const config = await getOrCreateConfig(String(user.businessId));
  if (!config.sheetsConnected || !config.googleSheetId) throw new AppError('No sheet connected', 400);

  const businessId = String(user.businessId);
  const [incomeAgg, expenseAgg, clientCount, invoices] = await Promise.all([
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
    totalClients: clientCount,
    pendingInvoices: invoices.filter((i) => i.status === 'sent' || i.status === 'overdue').length,
    paidInvoices: invoices.filter((i) => i.status === 'paid').length,
  });
};
