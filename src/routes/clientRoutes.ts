import express from 'express';
const router = express.Router();
import {
  createClient,
  getClients,
  getClientById,
  updateClient,
  deleteClient,
  generatePortalLink,
  getClientPortal,
} from '../controllers/clientController.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createClientSchema } from '../middleware/schemas.js';

// Public portal — must be before /:id to avoid conflict
router.get('/portal/:token', getClientPortal);

router.route('/').post(protect, validate(createClientSchema), createClient).get(protect, getClients);
router
  .route('/:id')
  .get(protect, getClientById)
  .put(protect, updateClient)
  .delete(protect, deleteClient);

router.post('/:id/portal', protect, generatePortalLink);

export default router;
