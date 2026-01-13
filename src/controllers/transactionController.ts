import type { Request, Response } from "express";
import Transaction from "../models/Transaction.js";
import Client from "../models/Client.js";

import { createNotification } from "./notificationController.js";

// @desc    Get total revenue stats
// @route   GET /api/transactions/revenue-stats
// @access  Private
export const getRevenueStats = async (req: Request, res: Response) => {
    try {
        const income = await Transaction.aggregate([
            { $match: { businessId: (req.user as any).businessId, type: 'income' } }, // Filter by businessId
            { $group: { _id: null, totalIncome: { $sum: '$amount' } } }
        ]);

        const expense = await Transaction.aggregate([
            { $match: { businessId: (req.user as any).businessId, type: 'expense' } }, // Filter by businessId
            { $group: { _id: null, totalExpense: { $sum: '$amount' } } }
        ]);

        res.status(200).json({
            totalIncome: income.length > 0 ? income[0].totalIncome : 0,
            totalExpense: expense.length > 0 ? expense[0].totalExpense : 0
        });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: (error as Error).message });
        console.error("Error fetching revenue stats:", error);
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

        // Create a notification for the user who created the transaction
        await createNotification({
            businessId: user.businessId,
            userId: user._id,
            message: `New ${type} transaction of ${amount} recorded for client.`,
            link: `/transactions`,
        });

        res.status(201).json(transaction);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: (error as Error).message });
        console.error("Error creating transaction:", error);
    }
};

// @desc    Get all transactions for a business
// @route   GET /api/transactions
// @access  Private
export const getTransactions = async (req: Request, res: Response) => {
    try {
        const { clientId } = req.query;
        const filter: any = { businessId: (req.user as any).businessId }; // Filter by businessId
        if (clientId) {
            filter.clientId = clientId; // Add clientId filter if provided
        }
        const transactions = await Transaction.find(filter).populate("recordedBy", "name");
        res.json(transactions);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: (error as Error).message });
        console.error("Error fetching transactions:", error);
    }
};

// @desc    Get transaction by ID
// @route   GET /api/transactions/:id
// @access  Private
export const getTransactionById = async (req: Request, res: Response) => {
    try {
        const transaction = await Transaction.findOne({ _id: req.params.id, businessId: (req.user as any).businessId }); // Filter by businessId
        if (transaction) {
            res.json(transaction);
        } else {
            res.status(404).json({ message: "Transaction not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error: (error as Error).message });
        console.error("Error fetching transaction by ID:", error);
    }
};

// @desc    Update transaction
// @route   PUT /api/transactions/:id
// @access  Private
export const updateTransaction = async (req: Request, res: Response) => {
    try {
        const transaction = await Transaction.findOne({ _id: req.params.id, businessId: (req.user as any).businessId }); // Filter by businessId
        if (transaction) {
            transaction.amount = req.body.amount || transaction.amount;
            transaction.type = req.body.type || transaction.type;
            transaction.category = req.body.category || transaction.category;

            const updatedTransaction = await transaction.save();

            res.json(updatedTransaction);
        } else {
            res.status(404).json({ message: "Transaction not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error: (error as Error).message });
        console.error("Error updating transaction:", error);
    }
};

// @desc    Delete transaction
// @route   DELETE /api/transactions/:id
// @access  Private
export const deleteTransaction = async (req: Request, res: Response) => {
    try {
        const transaction = await Transaction.findOne({ _id: req.params.id, businessId: (req.user as any).businessId }); // Filter by businessId
        if (transaction) {
            await transaction.deleteOne();
            res.json({ message: "Transaction removed" });
        } else {
            res.status(404).json({ message: "Transaction not found" });
        }
    } catch (error) {
        res.status(500).json({ message: "Server error", error: (error as Error).message });
        console.error("Error deleting transaction:", error);
    }
};
