// src/routes/exportRoutes.ts
import express from 'express';
import { protect } from '../middleware/auth.js';
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

// All other routes are protected
router.use(protect);

// Sheet connection
router.post('/disconnect', disconnectSheet);

// Status & control
router.get('/status', getExportStatus);
router.post('/toggle-sync', toggleAutoSync);

// Historical bulk sync
router.post('/sync-all', syncAllData);

// Summary tab
router.post('/summary', writeDailySummary);

// Webhooks
router.get('/webhooks', listWebhooks);
router.post('/webhooks', registerWebhook);
router.delete('/webhooks/:id', deleteWebhook);
router.post('/webhooks/:id/test', testWebhook);

export default router;
