import cron from 'node-cron';
import ExportConfig from '../models/ExportConfig.js';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import { writeSummaryRow } from './googleSheetsService.js';
import { generateDueRecurringInvoices } from '../controllers/recurringInvoiceController.js';

/**
 * Scheduled jobs for OpsFlow Automation.
 * Uses node-cron so the schedule survives process restarts as long as the
 * process itself is supervised — restart picks up the next cron tick rather
 * than re-arming a one-shot setTimeout that may have already fired.
 */

const NIGHTLY_SUMMARY_CRON = process.env.NIGHTLY_SUMMARY_CRON || '59 23 * * *';
const OVERDUE_SWEEP_CRON = process.env.OVERDUE_SWEEP_CRON || '*/30 * * * *';
const RECURRING_INVOICE_CRON = process.env.RECURRING_INVOICE_CRON || '0 7 * * *';

export const initCronJobs = () => {
  if (!cron.validate(NIGHTLY_SUMMARY_CRON)) {
    console.warn(`[Cron] Invalid NIGHTLY_SUMMARY_CRON expression "${NIGHTLY_SUMMARY_CRON}". Skipping summary job.`);
  } else {
    cron.schedule(NIGHTLY_SUMMARY_CRON, runNightlyJob);
    console.log(`[Cron] Nightly summary scheduled: "${NIGHTLY_SUMMARY_CRON}"`);
  }

  if (!cron.validate(OVERDUE_SWEEP_CRON)) {
    console.warn(`[Cron] Invalid OVERDUE_SWEEP_CRON expression "${OVERDUE_SWEEP_CRON}". Skipping overdue sweep.`);
  } else {
    cron.schedule(OVERDUE_SWEEP_CRON, markOverdueInvoices);
    console.log(`[Cron] Overdue invoice sweep scheduled: "${OVERDUE_SWEEP_CRON}"`);
  }

  if (!cron.validate(RECURRING_INVOICE_CRON)) {
    console.warn(`[Cron] Invalid RECURRING_INVOICE_CRON expression "${RECURRING_INVOICE_CRON}". Skipping recurring invoices job.`);
  } else {
    cron.schedule(RECURRING_INVOICE_CRON, generateDueRecurringInvoices);
    console.log(`[Cron] Recurring invoices scheduled: "${RECURRING_INVOICE_CRON}"`);
  }
};

async function runNightlyJob() {
  console.log('[Cron] Running nightly jobs...');
  try {
    await markOverdueInvoices();

    const configs = await ExportConfig.find({ sheetsConnected: true, googleSheetId: { $ne: '' } });
    for (const config of configs) {
      await processDailySummary(config);
    }
    console.log(`[Cron] Completed nightly summary for ${configs.length} businesses.`);
  } catch (error) {
    console.error('[Cron] Error in nightly job:', error);
  }
}

async function markOverdueInvoices() {
  try {
    const result = await Invoice.updateMany(
      {
        dueDate: { $lt: new Date() },
        status: { $in: ['draft', 'sent'] },
      },
      { $set: { status: 'overdue' } },
    );
    if (result.modifiedCount > 0) {
      console.log(`[Cron] Marked ${result.modifiedCount} invoices as overdue.`);
    }
  } catch (error) {
    console.error('[Cron] Failed to mark overdue invoices:', error);
  }
}

async function processDailySummary(config: any) {
  try {
    const businessId = config.businessId;
    const today = new Date();
    const startDate = new Date(today);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);

    const [incomeAgg, expenseAgg, totalClients, invoices] = await Promise.all([
      Transaction.aggregate([
        { $match: { businessId, type: 'income', createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { businessId, type: 'expense', createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Client.countDocuments({ businessId }),
      Invoice.find({ businessId }),
    ]);

    const totalIncome = incomeAgg[0]?.total ?? 0;
    const totalExpenses = expenseAgg[0]?.total ?? 0;

    await writeSummaryRow(String(businessId), config.googleSheetId, {
      date: today.toLocaleDateString(),
      totalIncome,
      totalExpenses,
      netProfit: totalIncome - totalExpenses,
      totalClients,
      pendingInvoices: invoices.filter((i: any) => i.status === 'sent' || i.status === 'overdue').length,
      paidInvoices: invoices.filter((i: any) => i.status === 'paid').length,
    });
  } catch (error) {
    console.error(`[Cron] Failed to process summary for business ${config.businessId}:`, error);
  }
}
