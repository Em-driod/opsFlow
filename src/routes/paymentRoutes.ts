import express from 'express';
import {
  getPaymentSettings,
  updatePaymentSettings,
  listCredits,
  matchCredit,
  dismissCredit,
  linkMono,
  unlinkMono,
  syncMono,
  inboundEmailWebhook,
  monoWebhook,
} from '../controllers/orderController.js';
import { protect, admin } from '../middleware/auth.js';

const router = express.Router();

// Webhooks — authenticated by shared secrets, not user sessions
router.post('/webhooks/email', inboundEmailWebhook);
router.post('/webhooks/mono', monoWebhook);

// Owner
router.route('/settings').get(protect, getPaymentSettings).put(protect, admin, updatePaymentSettings);
router.get('/credits', protect, listCredits);
router.post('/credits/:id/match', protect, admin, matchCredit);
router.post('/credits/:id/dismiss', protect, admin, dismissCredit);
router.post('/mono/link', protect, admin, linkMono);
router.post('/mono/sync', protect, syncMono);
router.delete('/mono', protect, admin, unlinkMono);

export default router;
