import type { Request, Response } from 'express';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Tesseract from 'tesseract.js';

import { createNotification } from './notificationController.js';
import { enqueue } from '../services/exportQueueService.js';
import { fire } from '../services/webhookService.js';
import { emitToBusiness } from '../services/socketService.js';
import { predictCategory, learnTransactionCategory } from '../services/learningService.js';

// Category keywords for classification
const categoryKeywords: Record<string, string[]> = {
  'Food & Dining': ['restaurant', 'cafe', 'coffee', 'food', 'meal', 'lunch', 'dinner', 'breakfast', 'pizza', 'burger'],
  'Transportation': ['uber', 'lyft', 'taxi', 'gas', 'fuel', 'parking', 'transit', 'bus', 'train', 'flight', 'airline'],
  'Utilities': ['electric', 'water', 'gas bill', 'internet', 'phone', 'utility', 'power'],
  'Office Supplies': ['office', 'supplies', 'paper', 'printer', 'ink', 'staples', 'desk'],
  'Software & Services': ['software', 'subscription', 'saas', 'cloud', 'hosting', 'domain'],
  'Professional Services': ['consulting', 'legal', 'accounting', 'lawyer', 'attorney'],
  'Marketing': ['advertising', 'ads', 'marketing', 'promotion', 'campaign'],
  'Equipment': ['equipment', 'hardware', 'computer', 'laptop', 'monitor', 'keyboard'],
  'Rent': ['rent', 'lease', 'property'],
  'Insurance': ['insurance', 'policy', 'coverage'],
};

// Income keywords
const incomeKeywords = ['invoice', 'payment received', 'deposit', 'income', 'revenue', 'sale', 'sold', 'payment from', 'credit'];

// Expense keywords
const expenseKeywords = ['receipt', 'bill', 'expense', 'purchase', 'bought', 'paid', 'debit', 'charge', 'fee', 'cost'];

// Helper: Extract amounts from text
const extractAmounts = (text: string): number[] => {
  const patterns = [
    /\$\s?([\d,]+\.?\d*)/g,
    /(?:total|amount|sum|due|balance)[:\s]*\$?\s?([\d,]+\.?\d*)/gi,
  ];

  const amounts: number[] = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(value) && value > 0) {
          amounts.push(value);
        }
      }
    }
  }
  return [...new Set(amounts)].sort((a, b) => b - a);
};

// Helper: Determine transaction type based on keywords
const determineType = (text: string): 'income' | 'expense' => {
  const lowerText = text.toLowerCase();

  let incomeScore = 0;
  let expenseScore = 0;

  for (const keyword of incomeKeywords) {
    if (lowerText.includes(keyword)) incomeScore++;
  }

  for (const keyword of expenseKeywords) {
    if (lowerText.includes(keyword)) expenseScore++;
  }

  return incomeScore > expenseScore ? 'income' : 'expense';
};

// Helper: Determine category based on keywords
const determineCategory = (text: string): string => {
  const lowerText = text.toLowerCase();

  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return category;
      }
    }
  }

  return 'Uncategorized';
};

// Helper: Extract description from text (first meaningful line)
const extractDescription = (text: string): string => {
  const lines = text.split('\n').filter(line => line.trim().length > 3);

  // Try to find a business name or main title (usually near the top)
  for (const line of lines.slice(0, 5)) {
    const trimmed = line.trim();
    // Skip lines that are just numbers or dates
    if (!/^\d+$/.test(trimmed) && !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(trimmed)) {
      return trimmed.substring(0, 100); // Limit length
    }
  }

  return 'Scanned Transaction';
};

// @desc    Scan a transaction document using OCR
// @route   POST /api/transactions/scan
// @access  Private
export const scanTransaction = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    // Perform OCR on the image
    const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng', {
      logger: (m) => console.log(m.status, m.progress),
    });

    console.log('OCR extracted text:', text);

    // Extract transaction data using pattern matching
    const amounts = extractAmounts(text);
    const type = determineType(text);
    const description = extractDescription(text);

    // 🧠 Autonomous Learning Engine Prediction
    const businessId = String((req.user as any).businessId);
    let category = await predictCategory(businessId, description);
    
    // Fallback to static keyword deduction if no historical learning exists
    if (!category) {
      category = determineCategory(text);
    }

    // Create transaction(s) from extracted data
    const transactions = amounts.length > 0
      ? amounts.map((amount, index) => ({
        amount,
        type,
        description: index === 0 ? description : `${description} (Item ${index + 1})`,
        category,
      }))
      : [{ amount: 0, type, description, category }];

    // Return only the main transaction (largest amount) and the rest as additional
    const structuredTransactions = transactions.map(tx => ({
      amount: tx.amount,
      type: tx.type,
      description: tx.description,
      category: tx.category,
    }));

    res.status(200).json({ text, transactions: structuredTransactions });
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error processing image with OCR', error: (error as Error).message });
    console.error('Error scanning transaction with OCR:', error);
  }
};

// @desc    Get total revenue stats
// @route   GET /api/transactions/revenue-stats
// @access  Private
export const getRevenueStats = async (req: Request, res: Response) => {
  try {
    const income = await Transaction.aggregate([
      { $match: { businessId: (req.user as any).businessId, type: 'income' } }, // Filter by businessId
      { $group: { _id: null, totalIncome: { $sum: '$amount' } } },
    ]);

    const expense = await Transaction.aggregate([
      { $match: { businessId: (req.user as any).businessId, type: 'expense' } }, // Filter by businessId
      { $group: { _id: null, totalExpense: { $sum: '$amount' } } },
    ]);

    res.status(200).json({
      totalIncome: income.length > 0 ? income[0].totalIncome : 0,
      totalExpense: expense.length > 0 ? expense[0].totalExpense : 0,
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
    const { clientId, amount, type, category, description } = req.body;
    const user = req.user as any;
    const recordedBy = user._id;

    const transaction = await Transaction.create({
      clientId,
      businessId: user.businessId,
      amount,
      type,
      category,
      description,
      recordedBy,
    });

    // 🧠 Learn from this manual categorization
    await learnTransactionCategory(String(user.businessId), description || '', category);

    // Create a notification for the user who created the transaction
    await createNotification({
      businessId: user.businessId,
      userId: user._id,
      message: `New ${type} transaction of ${amount} recorded for client.`,
      link: `/transactions`,
    });

    // 🔄 Auto-sync to Google Sheets + fire webhook
    enqueue({ type: 'transaction', action: 'created', data: transaction.toObject(), businessId: String(user.businessId) });
    fire('transaction.created', String(user.businessId), transaction.toObject());
    
    // 🔌 Emit Real-Time Event
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
    const { clientId } = req.query;
    const user = req.user as any;
    const filter: any = { 
      businessId: user.businessId, // Filter by businessId
      recordedBy: user._id // Only show transactions created by this user
    };
    if (clientId) {
      filter.clientId = clientId; // Add clientId filter if provided
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
    }); // Filter by businessId
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
    }); // Filter by businessId
    if (transaction) {
      transaction.amount = req.body.amount || transaction.amount;
      transaction.type = req.body.type || transaction.type;
      transaction.category = req.body.category || transaction.category;

      const updatedTransaction = await transaction.save();

      // 🧠 Learn from any corrections the user makes
      await learnTransactionCategory(String((req.user as any).businessId), updatedTransaction.description || '', updatedTransaction.category);

      // 🔄 Auto-sync to Google Sheets + fire webhook
      enqueue({ type: 'transaction', action: 'updated', data: updatedTransaction.toObject(), businessId: String((req.user as any).businessId) });
      fire('transaction.updated', String((req.user as any).businessId), updatedTransaction.toObject());
      
      // 🔌 Emit Real-Time Event
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
    }); // Filter by businessId
    if (transaction) {
      await transaction.deleteOne();
      
      // 🔌 Emit Real-Time Event
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
