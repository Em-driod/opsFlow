import Business from '../models/Business.js';
import ExportConfig from '../models/ExportConfig.js';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import { writeSummaryRow } from './googleSheetsService.js';

/**
 * Scheduled jobs for OpsFlow Automation - Manual Timer Version
 * REASON: Uses setInterval to avoid node-cron dependency install issues.
 */
export const initCronJobs = () => {
  // Run once every 6 hours to check if it's "Summary Time" (near 11:59 PM)
  // Or more simply, let's just use a dedicated timeout for the next run.
  scheduleNextRun();
  console.log('[Cron] Manual automation scheduler initialized.');
};

function scheduleNextRun() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(23, 59, 0, 0);

  // If it's already past 11:59 PM, schedule for tomorrow
  if (now > nextRun) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const delay = nextRun.getTime() - now.getTime();
  
  console.log(`[Cron] Next summary report scheduled in ${Math.round(delay / 1000 / 60)} minutes.`);

  setTimeout(async () => {
    await runNightlyJob();
    scheduleNextRun(); // Reschedule for next day
  }, delay);
}

async function runNightlyJob() {
  console.log('[Cron] Running nightly summary report for all connected businesses...');
  
  try {
    // Find all businesses with connected sheets
    const configs = await ExportConfig.find({ sheetsConnected: true, googleSheetId: { $ne: '' } });
    
    for (const config of configs) {
      await processDailySummary(config);
    }
    
    console.log(`[Cron] Completed nightly summary for ${configs.length} businesses.`);
  } catch (error) {
    console.error('[Cron] Error in nightly summary job:', error);
  }
}

/**
 * Process and write the daily summary for a specific business
 */
async function processDailySummary(config: any) {
  try {
    const businessId = config.businessId;
    const today = new Date();
    const startDate = new Date(today);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);

    // Fetch aggregate data
    const [incomeAgg, expenseAgg, totalClients, invoices] = await Promise.all([
      Transaction.aggregate([
        { $match: { businessId, type: 'income', createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { businessId, type: 'expense', createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Client.countDocuments({ businessId }),
      Invoice.find({ businessId })
    ]);

    const totalIncome = incomeAgg[0]?.total ?? 0;
    const totalExpenses = expenseAgg[0]?.total ?? 0;

    await writeSummaryRow(config.googleSheetId, {
      date: today.toLocaleDateString(),
      totalIncome,
      totalExpenses,
      netProfit: totalIncome - totalExpenses,
      totalClients: totalClients,
      pendingInvoices: invoices.filter((i: any) => i.status === 'sent' || i.status === 'overdue').length,
      paidInvoices: invoices.filter((i: any) => i.status === 'paid').length,
    });

  } catch (error) {
    console.error(`[Cron] Failed to process summary for business ${config.businessId}:`, error);
  }
}
