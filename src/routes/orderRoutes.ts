import express from 'express';
import {
  placeOrder,
  trackOrder,
  markSent,
  listOrders,
  getOrder,
  confirmPayment,
  updateStatus,
  advanceStage,
  undoStage,
} from '../controllers/orderController.js';
import { protect, admin } from '../middleware/auth.js';

const router = express.Router();

// Public — customers ordering from a business page
router.post('/public/:slug', placeOrder);
router.get('/public/track/:token', trackOrder);
router.post('/public/track/:token/sent', markSent);

// Owner
router.get('/', protect, listOrders);
router.get('/:id', protect, getOrder);
router.post('/:id/confirm-payment', protect, admin, confirmPayment);
router.put('/:id/status', protect, updateStatus);
router.put('/:id/stage', protect, advanceStage);
router.post('/:id/stage/undo', protect, undoStage);

export default router;
