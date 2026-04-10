// src/routes/exportRoutes.ts
import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  connectSheet,
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

// All routes are protected
router.use(protect);

// Sheet connection
router.post('/connect', connectSheet);
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
