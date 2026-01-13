import express from "express";
import {
    createInvoice,
    getInvoices,
    getInvoiceById,
    updateInvoiceStatus
} from "../controllers/invoiceController.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.route("/")
    .post(protect, createInvoice)
    .get(protect, getInvoices);

router.route("/:id")
    .get(protect, getInvoiceById);

router.route("/:id/status")
    .put(protect, updateInvoiceStatus);

export default router;
