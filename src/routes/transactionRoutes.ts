import express from "express";
const router = express.Router();
import {
    createTransaction,
    getTransactions,
    getTransactionById,
    updateTransaction,
    deleteTransaction,
    getRevenueStats,
} from "../controllers/transactionController.js";
import { protect } from "../middleware/auth.js";

router.route("/").post(protect, createTransaction).get(protect, getTransactions);
router.route("/revenue-stats").get(protect, getRevenueStats);
router.route("/:id").get(protect, getTransactionById).put(protect, updateTransaction).delete(protect, deleteTransaction);

export default router;
