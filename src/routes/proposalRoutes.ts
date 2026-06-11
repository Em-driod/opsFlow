import express from 'express';
const router = express.Router();
import {
  getProposals,
  createProposal,
  updateProposal,
  deleteProposal,
  sendProposal,
  convertToInvoice,
  getPublicProposal,
  acceptProposal,
  declineProposal,
} from '../controllers/proposalController.js';
import { protect } from '../middleware/auth.js';

// Public routes — no auth
router.get('/public/:id', getPublicProposal);
router.post('/public/:id/accept', acceptProposal);
router.post('/public/:id/decline', declineProposal);

// Protected routes
router.route('/').get(protect, getProposals).post(protect, createProposal);
router.route('/:id').put(protect, updateProposal).delete(protect, deleteProposal);
router.post('/:id/send', protect, sendProposal);
router.post('/:id/convert', protect, convertToInvoice);

export default router;
