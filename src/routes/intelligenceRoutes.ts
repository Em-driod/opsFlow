import express from 'express';
import { getBusinessAdvisorState } from '../controllers/intelligenceController.js';
import { parseCommand } from '../controllers/nlpController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/advisor', protect, getBusinessAdvisorState);
router.post('/parse', protect, parseCommand);

export default router;
