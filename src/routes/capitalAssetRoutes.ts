import express from 'express';
import { listAssets, createAsset, updateAsset, deleteAsset } from '../controllers/capitalAssetController.js';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';

const router = express.Router();

// Capital assets drive depreciation / tax posture — staff view, admins manage.
router.route('/').get(protect, listAssets).post(protect, permit('admin'), createAsset);
router.route('/:id').put(protect, permit('admin'), updateAsset).delete(protect, permit('admin'), deleteAsset);

export default router;
