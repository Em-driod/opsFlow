// src/services/exportQueueService.ts
// Async queue for Google Sheets sync jobs.
// Records are enqueued after save() and processed asynchronously.
// Failed jobs are retried up to MAX_RETRIES times with backoff.

import {
  appendRow,
  transactionToRow,
  clientToRow,
  invoiceToRow,
  payrollToRow,
  SHEET_TABS,
} from './googleSheetsService.js';
import ExportConfig from '../models/ExportConfig.js';

interface SyncJob {
  type: 'transaction' | 'client' | 'invoice' | 'payroll';
  action: 'created' | 'updated';
  data: any;
  businessId: string;
  retries: number;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds
const queue: SyncJob[] = [];
let isProcessing = false;

// Enqueue a new sync job (called after every record save)
export function enqueue(job: Omit<SyncJob, 'retries'>): void {
  queue.push({ ...job, retries: 0 });
  if (!isProcessing) {
    processQueue();
  }
}

// Process the queue one job at a time
async function processQueue(): Promise<void> {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  while (queue.length > 0) {
    const job = queue.shift()!;
    await processJob(job);
  }

  isProcessing = false;
}

// Process a single sync job
async function processJob(job: SyncJob): Promise<void> {
  try {
    // Get the business's export config
    const config = await ExportConfig.findOne({ businessId: job.businessId });
    if (!config || !config.sheetsConnected || !config.googleSheetId || !config.autoSyncEnabled) {
      return; // Sheets not configured — skip silently
    }

    const sheetId = config.googleSheetId;
    let row: (string | number)[] = [];
    let tabName = '';

    switch (job.type) {
      case 'transaction':
        row = transactionToRow(job.data);
        tabName = SHEET_TABS.TRANSACTIONS;
        break;
      case 'client':
        row = clientToRow(job.data);
        tabName = SHEET_TABS.CLIENTS;
        break;
      case 'invoice':
        row = invoiceToRow(job.data);
        tabName = SHEET_TABS.INVOICES;
        break;
      case 'payroll':
        row = payrollToRow(job.data);
        tabName = SHEET_TABS.PAYROLL;
        break;
    }

    const success = await appendRow(sheetId, tabName, row);

    // Log the sync event in the config document
    const eventEntry = {
      type: job.type,
      action: job.action,
      recordId: String(job.data._id ?? ''),
      status: success ? 'synced' : 'failed',
      error: success ? undefined : 'Append failed',
      syncedAt: new Date(),
    };

    // Keep only last 100 events
    config.syncEvents = [...config.syncEvents.slice(-99), eventEntry];
    await config.save();

    if (!success && job.retries < MAX_RETRIES) {
      // Retry with backoff
      setTimeout(() => {
        queue.push({ ...job, retries: job.retries + 1 });
        if (!isProcessing) processQueue();
      }, RETRY_DELAY_MS * (job.retries + 1));
    }
  } catch (err) {
    console.error(`[Queue] Job failed (${job.type} ${job.action}):`, err);
    if (job.retries < MAX_RETRIES) {
      setTimeout(() => {
        queue.push({ ...job, retries: job.retries + 1 });
        if (!isProcessing) processQueue();
      }, RETRY_DELAY_MS * (job.retries + 1));
    }
  }
}

// Get current queue stats
export function getQueueStats(): { pending: number; isProcessing: boolean } {
  return { pending: queue.length, isProcessing };
}
