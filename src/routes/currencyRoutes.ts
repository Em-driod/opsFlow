import express from 'express';
import { getRates } from '../controllers/currencyController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/rates').get(protect, getRates);

export default router;
