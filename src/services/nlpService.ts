import mongoose from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import { checkAiRateLimit } from './aiRateLimiter.js';
import { AppError } from '../utils/AppError.js';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

interface RawClient {
  _id: unknown;
  status?: string;
  balance?: number;
  businessValue?: number;
}

interface RawTransaction {
  amount: number;
  type: string;
  category?: string;
  description?: string;
  createdAt: Date;
  clientId?: unknown;
}

interface RawInvoice {
  invoiceNumber: string;
  total: number;
  dueDate: Date;
  status: string;
  clientId?: unknown;
  customClientName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PII REDACTION LAYER
//
// CRITICAL SECURITY FIX: The previous implementation sent raw client objects
// (with real names, emails, phone numbers, and financial history) directly to
// Gemini. This is a GDPR/data-privacy violation and a liability for any serious
// business using OpsFlow.
//
// This function sanitises the context BEFORE it leaves our server. Each real
// client is replaced by an anonymous alias (e.g., "Client A"). Dollar amounts
// and business logic are preserved so the AI can still answer questions, but
// no Personally Identifiable Information (PII) leaves the system.
// ─────────────────────────────────────────────────────────────────────────────
const redactContext = (
  clients: RawClient[],
  transactions: RawTransaction[],
  invoices: RawInvoice[],
): { safeContext: object; clientAliasMap: Record<string, string> } => {
  const clientAliasMap: Record<string, string> = {};
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  clients.forEach((client, idx) => {
    clientAliasMap[String(client._id)] = `Client ${labels[idx] ?? `#${idx + 1}`}`;
  });

  const safeClients = clients.map((c) => ({
    alias: clientAliasMap[String(c._id)] ?? 'Unknown Client',
    status: c.status,
    balance: c.balance,
    businessValue: c.businessValue,
  }));

  const safeTransactions = transactions.map((t) => ({
    amount: t.amount,
    type: t.type,
    category: t.category,
    description: t.description,
    createdAt: t.createdAt,
    client: t.clientId ? (clientAliasMap[String(t.clientId)] ?? 'Unknown Client') : null,
  }));

  const safeInvoices = invoices.map((inv) => ({
    invoiceNumber: inv.invoiceNumber,
    total: inv.total,
    dueDate: inv.dueDate,
    status: inv.status,
    client: inv.clientId
      ? (clientAliasMap[String(inv.clientId)] ?? 'Unknown Client')
      : (inv.customClientName ? 'Custom Client' : 'Unknown'),
  }));

  return {
    safeContext: {
      activeClients: safeClients,
      recentTransactions: safeTransactions,
      pendingInvoices: safeInvoices,
    },
    clientAliasMap,
  };
};

export const parseNlpCommand = async (businessId: mongoose.Types.ObjectId, command: unknown) => {
  if (!command || typeof command !== 'string') {
    throw new AppError('Invalid command provided', 400);
  }
  if (!apiKey) throw new AppError('Gemini API not configured', 500);

  const limit = checkAiRateLimit(String(businessId));
  if (!limit.allowed) {
    const err = new AppError(
      `Too many AI requests. Try again in ~${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
      429,
    );
    (err as AppError & { retryAfterSeconds?: number }).retryAfterSeconds = limit.retryAfterSeconds;
    throw err;
  }

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [recentTransactions, activeClients, pendingInvoices] = await Promise.all([
    Transaction.find({ businessId, createdAt: { $gte: startOfMonth } })
      .sort({ createdAt: -1 })
      .limit(100)
      .select('amount type description category createdAt clientId'),
    Client.find({ businessId, status: 'active' }).select('_id name email balance businessValue status'),
    Invoice.find({ businessId, status: { $in: ['sent', 'overdue'] } }).select(
      'invoiceNumber total dueDate status clientId customClientName',
    ),
  ]);

  const { safeContext } = redactContext(
    activeClients.map((c) => c.toObject()),
    recentTransactions.map((t) => t.toObject()),
    pendingInvoices.map((i) => i.toObject()),
  );

  const contextDump = JSON.stringify(safeContext);

  const model = genAI.getGenerativeModel({
    model: process.env.NLP_MODEL || 'gemini-2.0-flash',
    systemInstruction: `You are an elite, highly intelligent financial CFO Assistant for OpsFlow.
You have access to the user's anonymised live business data for the *current calendar month*.
Client real names and emails have been replaced with aliases (e.g., "Client A") for privacy.
Here is the sanitised JSON context: ${contextDump}

Your job is to determine the user's intent from their command and respond strictly in JSON.

If the user wants to LOG a transaction (e.g., "I spent $50 on Uber", "Got paid $1000"):
{
  "intent": "LOG_TRANSACTION",
  "data": {
    "amount": number,
    "type": "income" | "expense",
    "description": string
  }
}

If the user asks an ANALYTICAL QUESTION (e.g., "Who owes me the most?", "How much did we spend on software?"):
{
  "intent": "QUERY_DATA",
  "markdownResponse": "Write a highly professional, beautifully formatted Markdown response. Use bolding and short bullet points. Be concise, sound like an elite CFO. Reference clients by their alias (e.g. 'Client A'). If data is unavailable say so."
}

Rules:
- YOU MUST RESPOND ONLY IN VALID JSON. NEVER include \`\`\`json wrappers.
- Do not output anything outside the JSON structure.
`,
  });

  const result = await model.generateContent(command);
  const textOutput = result.response.text().trim();

  const cleanedJson = textOutput
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsedData;
  try {
    parsedData = JSON.parse(cleanedJson);
  } catch {
    console.error('[NLP Service] Failed to parse model output:', textOutput);
    throw new AppError('Failed to extract structured data from command', 422);
  }

  if (!parsedData.intent || !['LOG_TRANSACTION', 'QUERY_DATA'].includes(parsedData.intent)) {
    const err = new AppError('AI returned invalid intent structure', 422);
    (err as AppError & { rawData?: unknown }).rawData = parsedData;
    throw err;
  }

  return parsedData;
};
