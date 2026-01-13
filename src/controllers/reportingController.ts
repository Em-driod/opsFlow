import type { Request, Response } from "express";
import Transaction from "../models/Transaction.js";
import mongoose from "mongoose";

/**
 * @desc    Generate a financial summary report
 * @route   GET /api/reporting/financial-summary
 * @access  Private
 */
export const getFinancialSummary = async (req: Request, res: Response) => {
    try {
        const { startDate, endDate } = req.query;
        const businessId = (req.user as any).businessId;

        if (!startDate || !endDate) {
            return res.status(400).json({ message: "Start date and end date are required." });
        }

        const start = new Date(startDate as string);
        const end = new Date(endDate as string);

        const summary = await Transaction.aggregate([
            {
                $match: {
                    businessId: new mongoose.Types.ObjectId(businessId),
                    date: { $gte: start, $lte: end },
                },
            },
            {
                $group: {
                    _id: null,
                    totalIncome: {
                        $sum: { $cond: [{ $eq: ["$type", "income"] }, "$amount", 0] },
                    },
                    totalExpenses: {
                        $sum: { $cond: [{ $eq: ["$type", "expense"] }, "$amount", 0] },
                    },
                    totalTransactions: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    totalIncome: 1,
                    totalExpenses: 1,
                    netProfit: { $subtract: ["$totalIncome", "$totalExpenses"] },
                    totalTransactions: 1,
                }
            }
        ]);
        
        const report = summary.length > 0 ? summary[0] : {
            totalIncome: 0,
            totalExpenses: 0,
            netProfit: 0,
            totalTransactions: 0,
        };

        res.status(200).json(report);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error: (error as Error).message });
    }
};
