// src/services/googleSheetsService.ts
// Google Sheets sync engine for OpsFlow - Axios Version
// REASON: Switched to Axios + JWT to avoid dependency installation issues with googleapis
// Handles all reads/writes to the connected business spreadsheet using the Google Sheets REST API directly.

import axios from 'axios';
import jwt from 'jsonwebtoken';

// Tab names — these are auto-created in the sheet
export const SHEET_TABS = {
  TRANSACTIONS: '💰 Transactions',
  CLIENTS: '👥 Clients',
  INVOICES: '🧾 Invoices',
  PAYROLL: '💼 Payroll',
  SUMMARY: '📊 Summary',
};

// Column headers for each tab
const HEADERS = {
  [SHEET_TABS.TRANSACTIONS]: [
    'ID', 'Date', 'Type', 'Amount', 'Category', 'Description', 'Client ID', 'Recorded By', 'Created At',
  ],
  [SHEET_TABS.CLIENTS]: [
    'ID', 'Name', 'Email', 'Phone', 'Balance', 'Business Value', 'Status', 'Created At',
  ],
  [SHEET_TABS.INVOICES]: [
    'Invoice #', 'Client', 'Total', 'Tax', 'Subtotal', 'Status', 'Due Date', 'Notes', 'Created At',
  ],
  [SHEET_TABS.PAYROLL]: [
    'ID', 'Staff Name', 'Salary', 'Pay Date', 'Status', 'Created At',
  ],
  [SHEET_TABS.SUMMARY]: [
    'Report Date', 'Total Income', 'Total Expenses', 'Net Profit', 'Total Clients', 'Pending Invoices', 'Paid Invoices',
  ],
};

let cachedToken: { token: string; expiry: number } | null = null;

/**
 * Get an OAuth2 Access Token for the Google Sheets API using the Service Account credentials.
 */
async function getAccessToken(): Promise<string> {
  // Use cache if not expired
  if (cachedToken && cachedToken.expiry > Date.now() + 60000) {
    return cachedToken.token;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error(
      'Google Sheets credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in .env',
    );
  }

  const privateKey = rawKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', 
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: token,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const accessToken = response.data.access_token;
    cachedToken = {
      token: accessToken,
      expiry: Date.now() + (response.data.expires_in * 1000),
    };

    return accessToken;
  } catch (error: any) {
    console.error('[Sheets Auth] Token fetch failed:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Google Sheets API');
  }
}

/**
 * API call helper
 */
async function sheetsApiCall(method: 'get' | 'post', sheetId: string, endpoint: string, data?: any) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${endpoint}`;
  
  try {
    const response = await axios({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    });
    return response.data;
  } catch (error: any) {
    console.error(`[Sheets API] ${method.toUpperCase()} ${endpoint} failed:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Ensure a tab exists in the sheet; create it with headers if not
 */
async function ensureTabExists(sheetId: string, tabName: string): Promise<void> {
  try {
    // Get existing sheets
    const meta = await sheetsApiCall('get', sheetId, '?fields=sheets.properties.title');
    const existing = meta.sheets?.map((s: any) => s.properties?.title) ?? [];

    if (!existing.includes(tabName)) {
      // Create the tab
      await sheetsApiCall('post', sheetId, ':batchUpdate', {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      });

      // Write headers
      const headers = HEADERS[tabName];
      if (headers) {
        await sheetsApiCall('post', sheetId, `/values/'${tabName}'!A1:update?valueInputOption=RAW`, {
          values: [headers]
        });
      }
    }
  } catch (err: any) {
    // Handle case where we might have tried to add a sheet that was added since we checked
    if (err.response?.status !== 400) {
       console.error(`[Sheets] Failed to ensure tab "${tabName}":`, err.message);
    }
  }
}

/**
 * Append a single row to a tab
 */
export async function appendRow(sheetId: string, tabName: string, rowData: (string | number)[]): Promise<boolean> {
  try {
    await ensureTabExists(sheetId, tabName);
    await sheetsApiCall('post', sheetId, `/values/'${tabName}'!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      values: [rowData]
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Batch append multiple rows (used for historical sync)
 */
export async function batchAppendRows(sheetId: string, tabName: string, rows: (string | number)[][]): Promise<boolean> {
  if (!rows.length) return true;
  try {
    await ensureTabExists(sheetId, tabName);
    await sheetsApiCall('post', sheetId, `/values/'${tabName}'!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      values: rows
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Write summary row to the summary tab
 */
export async function writeSummaryRow(sheetId: string, summary: {
  date: string;
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  totalClients: number;
  pendingInvoices: number;
  paidInvoices: number;
}): Promise<boolean> {
  return appendRow(sheetId, SHEET_TABS.SUMMARY, [
    summary.date,
    summary.totalIncome,
    summary.totalExpenses,
    summary.netProfit,
    summary.totalClients,
    summary.pendingInvoices,
    summary.paidInvoices,
  ]);
}

/**
 * Initialize ALL tabs in a sheet
 */
export async function initializeSheetTabs(sheetId: string): Promise<void> {
  for (const tabName of Object.values(SHEET_TABS)) {
    await ensureTabExists(sheetId, tabName);
  }
}

/**
 * Format helpers
 */
export function transactionToRow(tx: any): (string | number)[] {
  return [
    String(tx._id),
    tx.createdAt ? new Date(tx.createdAt).toLocaleDateString() : '',
    tx.type ?? '',
    tx.amount ?? 0,
    tx.category ?? '',
    tx.description ?? '',
    tx.clientId ? String(tx.clientId) : '',
    tx.recordedBy ? String(tx.recordedBy) : '',
    tx.createdAt ? new Date(tx.createdAt).toISOString() : '',
  ];
}

export function clientToRow(client: any): (string | number)[] {
  return [
    String(client._id),
    client.name ?? '',
    client.email ?? '',
    client.phone ?? '',
    client.balance ?? 0,
    client.businessValue ?? 0,
    client.status ?? '',
    client.createdAt ? new Date(client.createdAt).toISOString() : '',
  ];
}

export function invoiceToRow(inv: any): (string | number)[] {
  return [
    inv.invoiceNumber ?? '',
    inv.customClientName ?? (inv.clientId ? String(inv.clientId) : ''),
    inv.total ?? 0,
    inv.tax ?? 0,
    inv.subtotal ?? 0,
    inv.status ?? '',
    inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '',
    inv.notes ?? '',
    inv.createdAt ? new Date(inv.createdAt).toISOString() : '',
  ];
}

export function payrollToRow(pay: any): (string | number)[] {
  return [
    String(pay._id),
    pay.staffName ?? '',
    pay.salary ?? 0,
    pay.payday ? new Date(pay.payday).toLocaleDateString() : '',
    pay.status ?? '',
    pay.createdAt ? new Date(pay.createdAt).toISOString() : '',
  ];
}

/**
 * Validate that we can access a sheet
 */
export async function validateSheetAccess(sheetId: string): Promise<{ valid: boolean; title?: string; error?: string }> {
  try {
    const meta = await sheetsApiCall('get', sheetId, '?fields=properties.title');
    return { valid: true, title: meta.properties?.title ?? 'Untitled Sheet' };
  } catch (err: any) {
    return { valid: false, error: err.response?.data?.error?.message || 'Could not access the spreadsheet' };
  }
}
