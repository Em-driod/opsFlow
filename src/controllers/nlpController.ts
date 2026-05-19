import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import { checkAiRateLimit } from '../services/aiRateLimiter.js';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

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
  clients: any[],
  transactions: any[],
  invoices: any[]
): { safeContext: object; clientAliasMap: Record<string, string> } => {

  // 1. Build alias map: real MongoDB _id -> "Client A", "Client B", etc.
  const clientAliasMap: Record<string, string> = {};
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  clients.forEach((client, idx) => {
    clientAliasMap[String(client._id)] = `Client ${labels[idx] ?? `#${idx + 1}`}`;
  });

  // 2. Sanitise clients — strip name, email, phone; keep financial signals
  const safeClients = clients.map((c) => ({
    alias: clientAliasMap[String(c._id)] ?? 'Unknown Client',
    status: c.status,
    balance: c.balance,
    businessValue: c.businessValue,
  }));

  // 3. Sanitise transactions — replace clientId with alias; keep amounts & categories
  const safeTransactions = transactions.map((t) => ({
    amount: t.amount,
    type: t.type,
    category: t.category,
    description: t.description, // vendor names are useful for AI; strip if stricter compliance needed
    createdAt: t.createdAt,
    client: t.clientId ? (clientAliasMap[String(t.clientId)] ?? 'Unknown Client') : null,
  }));

  // 4. Sanitise invoices — replace client info with alias; keep amounts & dates
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

// @desc    Parse natural language into structured data OR answer a contextual query
// @route   POST /api/intelligence/parse
// @access  Private
export const parseCommand = async (req: Request, res: Response) => {
  try {
    const { command } = req.body;
    const businessId = (req.user as any).businessId;

    if (!command || typeof command !== 'string') {
      return res.status(400).json({ message: 'Invalid command provided' });
    }

    if (!apiKey) {
      return res.status(500).json({ message: 'Gemini API not configured' });
    }

    const limit = checkAiRateLimit(String(businessId));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({
        message: `Too many AI requests. Try again in ~${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    // 1. Fetch raw data from database (current month only)
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [recentTransactions, activeClients, pendingInvoices] = await Promise.all([
      Transaction.find({ businessId, createdAt: { $gte: startOfMonth } })
        .sort({ createdAt: -1 })
        .limit(100)
        .select('amount type description category createdAt clientId'),
      Client.find({ businessId, status: 'active' }).select('_id name email balance businessValue status'),
      Invoice.find({ businessId, status: { $in: ['sent', 'overdue'] } })
        .select('invoiceNumber total dueDate status clientId customClientName'),
    ]);

    // 2. REDACT all PII before building the context dump
    const { safeContext } = redactContext(
      activeClients.map((c) => c.toObject()),
      recentTransactions.map((t) => t.toObject()),
      pendingInvoices.map((i) => i.toObject())
    );

    const contextDump = JSON.stringify(safeContext);

    // 3. Call Gemini with the sanitised, PII-free context.
    //    Flash is ~10x cheaper than 2.5-pro for this kind of structured task and
    //    consistently returns valid JSON for our intent schema.
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
    } catch (parseError) {
      console.error('[NLP Controller] Failed to parse model output:', textOutput);
      return res.status(422).json({ message: 'Failed to extract structured data from command' });
    }

    if (!parsedData.intent || !['LOG_TRANSACTION', 'QUERY_DATA'].includes(parsedData.intent)) {
      return res.status(422).json({ message: 'AI returned invalid intent structure', rawData: parsedData });
    }

    res.status(200).json(parsedData);
  } catch (error) {
    console.error('Error in NLP controller:', error);
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
