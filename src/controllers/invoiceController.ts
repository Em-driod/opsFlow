import type { Request, Response } from "express";
import Invoice from "../models/Invoice.js";
import { createNotification } from "./notificationController.js";

// A simple function to generate a unique invoice number
const generateInvoiceNumber = async () => {
    const lastInvoice = await Invoice.findOne().sort({ createdAt: -1 });
    if (lastInvoice) {
        const lastNumber = parseInt(lastInvoice.invoiceNumber.split('-')[1]);
        return `INV-${lastNumber + 1}`;
    }
    return 'INV-1001';
};

/**
 * @desc    Create a new invoice
 * @route   POST /api/invoices
 * @access  Private
 */
export const createInvoice = async (req: Request, res: Response) => {
    try {
        const { clientId, lineItems, dueDate, tax, notes } = req.body;
        const user = req.user as any;

        const subtotal = lineItems.reduce((acc: number, item: any) => acc + item.total, 0);
        const total = subtotal + (subtotal * (tax / 100));
        
        const invoice = new Invoice({
            businessId: user.businessId,
            clientId,
            invoiceNumber: await generateInvoiceNumber(),
            lineItems,
            subtotal,
            tax,
            total,
            dueDate,
            notes,
            status: 'draft',
        });

        const createdInvoice = await invoice.save();

        await createNotification({
            businessId: user.businessId,
            userId: user._id,
            message: `New invoice #${createdInvoice.invoiceNumber} created for a total of ${total}.`,
            link: `/invoices/${createdInvoice._id}`
        });

        res.status(201).json(createdInvoice);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error: (error as Error).message });
    }
};

/**
 * @desc    Get all invoices for a business
 * @route   GET /api/invoices
 * @access  Private
 */
export const getInvoices = async (req: Request, res: Response) => {
    try {
        const invoices = await Invoice.find({ businessId: (req.user as any).businessId })
            .populate('clientId', 'name')
            .sort({ createdAt: -1 });
        res.status(200).json(invoices);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error: (error as Error).message });
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
            businessId: (req.user as any).businessId
        }).populate('clientId', 'name email phone');
        
        if (!invoice) {
            return res.status(404).json({ message: 'Invoice not found' });
        }
        
        res.status(200).json(invoice);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error: (error as Error).message });
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
            { new: true }
        );

        if (!invoice) {
            return res.status(404).json({ message: 'Invoice not found' });
        }

        res.status(200).json(invoice);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error: (error as Error).message });
    }
};
