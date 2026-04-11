import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

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

    // 1. Fetch Context (Data for the current month for this business)
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [recentTransactions, activeClients, pendingInvoices] = await Promise.all([
      Transaction.find({ businessId, createdAt: { $gte: startOfMonth } })
        .sort({ createdAt: -1 })
        .limit(100) // increased limit since a month can have more
        .select('amount type description category createdAt'),
      Client.find({ businessId, status: 'active' }).select('name email balance businessValue'),
      Invoice.find({ businessId, status: { $in: ['sent', 'overdue'] } }).select('invoiceNumber total dueDate status customClientName')
    ]);

    const contextDump = JSON.stringify({
      recentTransactions,
      activeClients,
      pendingInvoices
    });

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-pro",
      systemInstruction: `You are an elite, highly intelligent financial CFO Assistant for OpsFlow. 
You have direct access to the user's live database context for the *current calendar month*.
Here is the JSON context of their recent business data: ${contextDump}

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
  "markdownResponse": "Write a highly professional, beautifully formatted Markdown response answering their question using the provided context. Use bolding and short bullet points. Be concise. Sound like an elite CFO. If you don't know the answer because it's not in the context, say 'I can only analyze data for the current calendar month and top clients currently...'"
}

Rules:
- YOU MUST RESPOND ONLY IN VALID JSON. NEVER include \`\`\`json wrappers. 
- Do not output anything outside the JSON structure.
`
    });
    
    const result = await model.generateContent(command);
    const textOutput = result.response.text().trim();
    
    const cleanedJson = textOutput.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    
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
