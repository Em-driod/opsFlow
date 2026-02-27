import type { Request, Response } from 'express';
import Invoice from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';
import { createNotification } from './notificationController.js';
import Tesseract from 'tesseract.js';

// Helper: Extract amounts from text using regex
const extractAmounts = (text: string): number[] => {
  const amountPatterns = [
    /\$\s?([\d,]+\.?\d*)/g,
    /(?:USD|EUR|GBP)\s?([\d,]+\.?\d*)/gi,
    /(?:total|amount|sum|due|balance)[:\s]*\$?\s?([\d,]+\.?\d*)/gi,
  ];

  const amounts: number[] = [];
  for (const pattern of amountPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!match[1]) continue;
      const value = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(value) && value > 0) {
        amounts.push(value);
      }
    }
  }
  return [...new Set(amounts)].sort((a, b) => b - a); // Unique, sorted descending
};

// Helper: Extract invoice number from text
const extractInvoiceNumber = (text: string): string => {
  const patterns = [
    /(?:invoice|inv|invoice\s*#|inv\s*#|invoice\s*no|inv\s*no)[:\s#]*([A-Z0-9-]+)/gi,
    /(?:#|no\.?|number)[:\s]*([A-Z]*\d{3,}[A-Z0-9-]*)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return '';
};

// Helper: Extract date from text
const extractDate = (text: string): string => {
  const patterns = [
    /(\d{4}[-/]\d{2}[-/]\d{2})/,                     // YYYY-MM-DD or YYYY/MM/DD
    /(\d{2}[-/]\d{2}[-/]\d{4})/,                     // DD-MM-YYYY or MM-DD-YYYY
    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/gi, // 15 Jan 2024
    /(?:due|date|dated)[:\s]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      // Try to parse and format as YYYY-MM-DD
      const dateStr = match[1];
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().substring(0, 10);
      }
      return dateStr;
    }
  }
  return new Date().toISOString().substring(0, 10); // Default to today
};

// Helper: Extract tax amount from text
const extractTax = (text: string): number => {
  const patterns = [
    /(?:tax|vat|gst)[:\s]*\$?\s?([\d,]+\.?\d*)/gi,
    /(?:tax|vat|gst)\s*(?:\d+%)?[:\s]*\$?\s?([\d,]+\.?\d*)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(value)) return value;
    }
  }
  return 0;
};

// Helper: Extract line items from text (basic pattern matching)
const extractLineItems = (text: string): Array<{ description: string; quantity: number; price: number; total: number }> => {
  const lines = text.split('\n');
  const lineItems: Array<{ description: string; quantity: number; price: number; total: number }> = [];

  // Look for lines with numbers that could be line items
  const itemPattern = /^(.+?)\s+(\d+)\s+\$?([\d,]+\.?\d*)\s+\$?([\d,]+\.?\d*)$/;

  for (const line of lines) {
    const match = itemPattern.exec(line.trim());
    if (match && match[1] && match[2] && match[3] && match[4]) {
      lineItems.push({
        description: match[1].trim(),
        quantity: parseInt(match[2]) || 1,
        price: parseFloat((match[3] as string).replace(/,/g, '')) || 0,
        total: parseFloat((match[4] as string).replace(/,/g, '')) || 0,
      });
    }
  }

  // If no structured items found, create a single item from detected amounts
  if (lineItems.length === 0) {
    const amounts = extractAmounts(text);
    const firstAmount = amounts[0];
    if (firstAmount !== undefined) {
      lineItems.push({
        description: 'Scanned Item',
        quantity: 1,
        price: firstAmount,
        total: firstAmount,
      });
    }
  }

  return lineItems;
};

// A simple function to generate a unique invoice number
const generateInvoiceNumber = async () => {
  const lastInvoice = await Invoice.findOne().sort({ createdAt: -1 });
  if (lastInvoice) {
    const lastNumber = parseInt(lastInvoice.invoiceNumber?.split('-')[1] ?? '1000');
    return `INV-${lastNumber + 1}`;
  }
  return 'INV-1001';
};

/**
 * @desc    Scan an invoice image using OCR
 * @route   POST /api/invoices/scan
 * @access  Private
 */
export const scanInvoice = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    // Perform OCR on the image buffer
    const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng', {
      logger: (m) => console.log(m.status, m.progress),
    });

    console.log('OCR extracted text:', text);

    // Extract invoice data using pattern matching
    const amounts = extractAmounts(text);
    const invoiceNumber = extractInvoiceNumber(text);
    const dueDate = extractDate(text);
    const tax = extractTax(text);
    const lineItems = extractLineItems(text);

    // Calculate total (largest amount found, or sum of line items)
    const lineItemsTotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const firstAmount = amounts[0];
    const total = firstAmount !== undefined ? firstAmount : lineItemsTotal;

    const invoiceData = {
      invoiceNumber: invoiceNumber || '',
      total: total,
      tax: tax,
      dueDate: dueDate,
      lineItems: lineItems,
      rawText: text, // Include raw text for debugging
    };

    res.status(200).json(invoiceData);
  } catch (error) {
    res.status(500).json({ message: 'Error processing invoice with OCR', error: (error as Error).message });
    console.error('Error scanning invoice:', error);
  }
};

/**
 * @desc    Create a new invoice
 * @route   POST /api/invoices
 * @access  Private
 */
export const createInvoice = async (req: Request, res: Response) => {
  try {
    const { clientId, customClientName, lineItems, dueDate, tax, notes, recordAsIncome } = req.body;
    const user = req.user as any;

    // Validate that either clientId or customClientName is provided
    if (!clientId && !customClientName) {
      return res.status(400).json({ message: 'Either clientId or customClientName is required' });
    }

    if (clientId && customClientName) {
      return res.status(400).json({ message: 'Cannot provide both clientId and customClientName' });
    }

    const subtotal = lineItems.reduce((acc: number, item: any) => acc + item.total, 0);
    const total = subtotal + subtotal * (tax / 100);

    const invoice = new Invoice({
      businessId: user.businessId,
      clientId: clientId || null,
      customClientName: customClientName || null,
      invoiceNumber: await generateInvoiceNumber(),
      lineItems,
      subtotal,
      tax,
      total,
      dueDate,
      notes,
    });

    if (recordAsIncome) {
      const incomeTransaction = await Transaction.create({
        clientId: clientId || null,
        businessId: user.businessId,
        amount: total,
        type: 'income',
        category: 'Sales',
        description: `Payment for Invoice #${invoice.invoiceNumber}${customClientName ? ` (${customClientName})` : ''}`,
        recordedBy: user._id,
      });

      invoice.transactionId = incomeTransaction._id as any;
      invoice.status = 'paid';
    }

    const createdInvoice = await invoice.save();

    await createNotification({
      businessId: user.businessId,
      userId: user._id,
      message: `New invoice #${createdInvoice.invoiceNumber} created for a total of ${total}.${recordAsIncome ? ' Recorded as income.' : ''}`,
      link: `/invoices/${createdInvoice._id}`,
    });

    res.status(201).json(createdInvoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Get all invoices for a business
 * @route   GET /api/invoices
 * @access  Private
 */
export const getInvoices = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const invoices = await Invoice.find({ 
      businessId: user.businessId,
      // Add a field to track which user created the invoice
      // For now, we'll assume all invoices are visible to all business users
      // In a real system, you might want to add a 'createdBy' field to invoices
    })
      .populate('clientId', 'name')
      .sort({ createdAt: -1 });
    res.status(200).json(invoices);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Get a single invoice by ID
 * @route   GET /api/invoices/:id
 * @access  Private
 */
export const getInvoiceById = async (req: Request, res: Response) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    }).populate('clientId', 'name email phone');

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};

/**
 * @desc    Update an invoice's status
 * @route   PUT /api/invoices/:id/status
 * @access  Private
 */
export const updateInvoiceStatus = async (req: Request, res: Response) => {
  try {
    const { status } = req.body;

    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, businessId: (req.user as any).businessId },
      { status },
      { new: true },
    );

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: (error as Error).message });
  }
};
