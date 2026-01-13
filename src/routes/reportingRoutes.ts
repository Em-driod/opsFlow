import express from "express";
import { getFinancialSummary } from "../controllers/reportingController.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.route("/financial-summary").get(protect, getFinancialSummary);

export default router;
