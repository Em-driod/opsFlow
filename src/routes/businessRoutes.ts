import express from 'express';
const router = express.Router();
import {
  createBusiness,
  getBusinessById,
  updateBusiness,
  deleteBusiness,
  addUserToBusiness,
} from '../controllers/businessController.js';
import { protect, admin } from '../middleware/auth.js';

router.route('/').post(protect, createBusiness);
router
  .route('/:id')
  .get(protect, getBusinessById)
  .put(protect, admin, updateBusiness)
  .delete(protect, admin, deleteBusiness);
router.route('/:id/users').post(protect, admin, addUserToBusiness);

export default router;
