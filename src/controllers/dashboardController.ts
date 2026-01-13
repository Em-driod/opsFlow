import type { Request, Response } from "express";
import Transaction from "../models/Transaction.js";
import Client from "../models/Client.js";
import mongoose from "mongoose";

/**
 * @desc    Get Key Performance Indicators (KPIs)
 * @route   GET /api/dashboard/kpis
 * @access  Private
 */
export const getKpis = async (req: Request, res: Response) => {
    try {
        const businessId = (req.user as any).businessId;
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Calculate total income and expenses in the last 30 days
        const recentTransactions = await Transaction.aggregate([
            {
                $match: {
                    businessId: new mongoose.Types.ObjectId(businessId),
                    createdAt: { $gte: thirtyDaysAgo },
                },
            },
            {
                $group: {
                    _id: "$type",
                    total: { $sum: "$amount" },
                },
            },
        ]);

        const income = recentTransactions.find(t => t._id === 'income')?.total || 0;
        const expenses = recentTransactions.find(t => t._id === 'expense')?.total || 0;

        // Get total number of active clients
        const totalClients = await Client.countDocuments({
            businessId,
            status: 'active',
        });

        res.status(200).json({
            totalIncome: income,
            totalExpenses: expenses,
            netProfit: income - expenses,
            totalClients,
        });
    } catch (error) {
        res.status(500).json({ message: "Server Error", error: (error as Error).message });
    }
};

/**
 * @desc    Get data for the income vs. expense chart
 * @route   GET /api/dashboard/chart-data
 * @access  Private
 */
export const getChartData = async (req: Request, res: Response) => {
    try {
        const businessId = (req.user as any).businessId;
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        // Aggregate transactions by month
        const chartData = await Transaction.aggregate([
            {
                $match: {
                    businessId: new mongoose.Types.ObjectId(businessId),
                    createdAt: { $gte: sixMonthsAgo },
                },
            },
            {
                $group: {
                    _id: {
                        year: { $year: "$createdAt" },
                        month: { $month: "$createdAt" },
                    },
                    totalIncome: {
                        $sum: { $cond: [{ $eq: ["$type", "income"] }, "$amount", 0] },
                    },
                    totalExpenses: {
                        $sum: { $cond: [{ $eq: ["$type", "expense"] }, "$amount", 0] },
                    },
                },
            },
            {
                $sort: { "_id.year": 1, "_id.month": 1 },
            },
            {
                $project: {
                    _id: 0,
                    month: {
                        $let: {
                            vars: {
                                monthsInYear: [null, "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
                            },
                            in: { $arrayElemAt: ["$$monthsInYear", "$_id.month"] }
                        }
                    },
                    totalIncome: 1,
                    totalExpenses: 1,
                }
            }
        ]);

        res.status(200).json(chartData);
    } catch (error) {
        res.status(500).json({ message: "Server Error", error: (error as Error).message });
    }
};
