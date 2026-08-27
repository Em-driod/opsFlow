// src/routes/exportRoutes.ts
import express from 'express';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';
import {
  googleAuthRedirect,
  googleAuthCallback,
  disconnectSheet,
  getExportStatus,
  toggleAutoSync,
  syncAllData,
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  testWebhook,
  writeDailySummary,
} from '../controllers/exportController.js';

const router = express.Router();

// OAuth routes (Public initially, auth checked inside or via URL token)
router.get('/google/auth', googleAuthRedirect);
router.get('/google/callback', googleAuthCallback);

// All other routes are protected. Connecting/pushing business data to external
// destinations (Google Sheets, webhooks) is an admin action; staff may read status.
router.use(protect);

// Status & control (read)
router.get('/status', getExportStatus);
router.get('/webhooks', listWebhooks);

// Sheet connection
router.post('/disconnect', permit('admin'), disconnectSheet);
router.post('/toggle-sync', permit('admin'), toggleAutoSync);

// Historical bulk sync
router.post('/sync-all', permit('admin'), syncAllData);

// Summary tab
router.post('/summary', permit('admin'), writeDailySummary);

// Webhooks (write)
router.post('/webhooks', permit('admin'), registerWebhook);
router.delete('/webhooks/:id', permit('admin'), deleteWebhook);
router.post('/webhooks/:id/test', permit('admin'), testWebhook);

export default router;
