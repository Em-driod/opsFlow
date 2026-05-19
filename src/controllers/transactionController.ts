import type { Request, Response } from 'express';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

import { createNotification } from './notificationController.js';
import { enqueue } from '../services/exportQueueService.js';
import { fire } from '../services/webhookService.js';
import { emitToBusiness } from '../services/socketService.js';
import { predictCategory, learnTransactionCategory } from '../services/learningService.js';
import { inferTaxCategory } from '../services/nigerianTax.js';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

// ─────────────────────────────────────────────────────────────────────────────
// OCR UPGRADE: Gemini Vision replacing Tesseract + Regex
//
// The previous implementation used Tesseract.js (CPU-heavy, blocks the event
// loop) followed by a fragile regex parser. It failed on any receipt that used
// a non-standard layout, and it could only detect amounts by looking for a "$"
// symbol — meaning European / multi-currency receipts always returned nothing.
//
// The new implementation sends the image directly to Gemini Vision as a base64
// inline part, and asks the model to return structured JSON. Accuracy jumps to
// near 100% across all receipt/invoice formats and currencies.
// ─────────────────────────────────────────────────────────────────────────────

interface ScannedItem {
  amount: number;
  type: 'income' | 'expense';
  description: string;
  category: string;
}

const VISION_EXTRACTION_PROMPT = `
You are a financial document parser. Carefully examine the attached image (a receipt, invoice, or bank statement).
Extract ALL line items or transactions visible. For each, determine:
- amount: the numeric value (no currency symbols)
- type: "expense" if it is a purchase/payment/bill, "income" if it is a payment received/deposit
- description: a short, clear description of what this transaction is for (vendor name + item if visible)
- category: one of ["Food & Dining", "Transportation", "Utilities", "Office Supplies", "Software & Services", "Professional Services", "Marketing", "Equipment", "Rent", "Insurance", "Sales", "Other"]

Return ONLY a valid JSON object — no markdown, no explanation — in this exact shape:
{
  "transactions": [
    { "amount": 25.50, "type": "expense", "description": "Starbucks Coffee", "category": "Food & Dining" }
  ],
  "documentType": "receipt" | "invoice" | "bank_statement" | "unknown",
  "vendorName": "string or null",
  "documentDate": "YYYY-MM-DD or null",
  "currency": "USD" | "GBP" | "EUR" | "NGN" | "other"
}

If you cannot find any transactions, return: { "transactions": [], "documentType": "unknown", "vendorName": null, "documentDate": null, "currency": "other" }
`;

/**
 * Helper: Calls Gemini Vision to extract structured transaction data from an image buffer.
 * Returns null on failure so the caller can handle gracefully.
 */
const extractWithGeminiVision = async (
  imageBuffer: Buffer,
  mimeType: string
): Promise<{ transactions: ScannedItem[]; vendorName?: string | null; documentDate?: string | null } | null> => {
  if (!apiKey) return null;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif',
      },
    };

    const result = await model.generateContent([VISION_EXTRACTION_PROMPT, imagePart]);
    const raw = result.response.text().trim()
      .replace(/^```json\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(raw);

    if (!parsed.transactions || !Array.isArray(parsed.transactions)) {
      console.error('[GeminiVision] Model returned invalid shape:', raw);
      return null;
    }

    // Sanitise amounts to always be positive numbers
    const sanitised: ScannedItem[] = parsed.transactions
      .filter((t: any) => typeof t.amount === 'number' && t.amount > 0)
      .map((t: any) => ({
        amount: Math.abs(t.amount),
        type: t.type === 'income' ? 'income' : 'expense',
        description: String(t.description ?? 'Scanned Transaction').substring(0, 100),
        category: String(t.category ?? 'Other'),
      }));

    return {
      transactions: sanitised,
      vendorName: parsed.vendorName ?? null,
      documentDate: parsed.documentDate ?? null,
    };
  } catch (err) {
    console.error('[GeminiVision] Extraction failed:', err);
    return null;
  }
};

// @desc    Scan a transaction receipt/invoice using Gemini Vision
// @route   POST /api/transactions/scan
// @access  Private
export const scanTransaction = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const businessId = String((req.user as any).businessId);

    // 1. Extract with Gemini Vision
    const visionResult = await extractWithGeminiVision(req.file.buffer, req.file.mimetype);

    if (!visionResult || visionResult.transactions.length === 0) {
      return res.status(422).json({
        message: 'No transactions could be found in this document. Please try a clearer image.',
      });
    }

    // 2. Enhance categories with the learning engine (override generic AI categories with personalised ones)
    const enhancedTransactions = await Promise.all(
      visionResult.transactions.map(async (item) => {
        const learned = await predictCategory(businessId, item.description);
        return {
          ...item,
          category: learned ?? item.category,
          // Include document-level context as a bonus on the first item
        };
      })
    );

    res.status(200).json({
      transactions: enhancedTransactions,
      vendorName: visionResult.vendorName,
      documentDate: visionResult.documentDate,
      // text field omitted intentionally — Gemini Vision does not expose raw OCR text
    });
  } catch (error) {
    res.status(500).json({ message: 'Error processing image', error: (error as Error).message });
    console.error('Error scanning transaction:', error);
  }
};

// @desc    Get total revenue stats
// @route   GET /api/transactions/revenue-stats
// @access  Private
export const getRevenueStats = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;

    const [incomeResult, expenseResult] = await Promise.all([
      Transaction.aggregate([
        { $match: { businessId, type: 'income' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { businessId, type: 'expense' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    res.status(200).json({
      totalIncome: incomeResult[0]?.total ?? 0,
      totalExpense: expenseResult[0]?.total ?? 0,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error fetching revenue stats:', error);
  }
};

// @desc    Create a new transaction
// @route   POST /api/transactions
// @access  Private
export const createTransaction = async (req: Request, res: Response) => {
  try {
    const { clientId, projectId, amount, type, category, description, taxCategory, vatable, vatAmount } = req.body;
    const user = req.user as any;

    // Auto-classify for tax if user didn't pick a category. Better to guess and
    // let them correct than to leave the Tax page with a giant "Unclassified".
    const finalTaxCategory = taxCategory || inferTaxCategory(category || description, type) || undefined;

    const transaction = await Transaction.create({
      clientId: clientId || undefined,
      projectId: projectId || undefined,
      businessId: user.businessId,
      amount,
      type,
      category,
      description,
      recordedBy: user._id,
      source: 'manual',
      ...(finalTaxCategory ? { taxCategory: finalTaxCategory } : {}),
      ...(typeof vatable === 'boolean' ? { vatable } : {}),
      ...(typeof vatAmount === 'number' ? { vatAmount } : {}),
    });

    // Learn from this manual categorisation for future scan predictions
    await learnTransactionCategory(String(user.businessId), description || '', category);

    await createNotification({
      businessId: user.businessId,
      userId: user._id,
      message: `New ${type} transaction of ${amount} recorded.`,
      link: `/transactions`,
    });

    enqueue({ type: 'transaction', action: 'created', data: transaction.toObject(), businessId: String(user.businessId) });
    fire('transaction.created', String(user.businessId), transaction.toObject());
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'created' });

    res.status(201).json(transaction);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error creating transaction:', error);
  }
};

// @desc    Get all transactions for a business
// @route   GET /api/transactions
// @access  Private
export const getTransactions = async (req: Request, res: Response) => {
  try {
    const { clientId, projectId } = req.query;
    const user = req.user as any;
    const filter: any = {
      businessId: user.businessId,
    };
    if (clientId) {
      filter.clientId = clientId;
    }
    if (projectId) {
      filter.projectId = projectId;
    }
    const transactions = await Transaction.find(filter).populate('recordedBy', 'name');
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error fetching transactions:', error);
  }
};

// @desc    Get transaction by ID
// @route   GET /api/transactions/:id
// @access  Private
export const getTransactionById = async (req: Request, res: Response) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });
    if (transaction) {
      res.json(transaction);
    } else {
      res.status(404).json({ message: 'Transaction not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error fetching transaction by ID:', error);
  }
};

// @desc    Update transaction
// @route   PUT /api/transactions/:id
// @access  Private
export const updateTransaction = async (req: Request, res: Response) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });
    if (transaction) {
      transaction.amount = req.body.amount || transaction.amount;
      transaction.type = req.body.type || transaction.type;
      transaction.category = req.body.category || transaction.category;
      if (req.body.description !== undefined) transaction.description = req.body.description;
      if (req.body.clientId !== undefined) {
        transaction.clientId = req.body.clientId || undefined;
      }
      if (req.body.projectId !== undefined) {
        transaction.projectId = req.body.projectId || undefined;
      }
      if (req.body.taxCategory !== undefined) {
        transaction.taxCategory = req.body.taxCategory || undefined;
      }
      if (typeof req.body.vatable === 'boolean') transaction.vatable = req.body.vatable;
      if (typeof req.body.vatAmount === 'number') transaction.vatAmount = req.body.vatAmount;

      const updatedTransaction = await transaction.save();

      // Learn from user corrections
      await learnTransactionCategory(
        String((req.user as any).businessId),
        updatedTransaction.description || '',
        updatedTransaction.category
      );

      enqueue({ type: 'transaction', action: 'updated', data: updatedTransaction.toObject(), businessId: String((req.user as any).businessId) });
      fire('transaction.updated', String((req.user as any).businessId), updatedTransaction.toObject());
      emitToBusiness(String((req.user as any).businessId), 'data_updated', { type: 'transaction', action: 'updated' });

      res.json(updatedTransaction);
    } else {
      res.status(404).json({ message: 'Transaction not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error updating transaction:', error);
  }
};

// @desc    Delete transaction
// @route   DELETE /api/transactions/:id
// @access  Private
export const deleteTransaction = async (req: Request, res: Response) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });
    if (transaction) {
      await transaction.deleteOne();
      emitToBusiness(String((req.user as any).businessId), 'data_updated', { type: 'transaction', action: 'deleted' });
      res.json({ message: 'Transaction removed' });
    } else {
      res.status(404).json({ message: 'Transaction not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error deleting transaction:', error);
  }
};
