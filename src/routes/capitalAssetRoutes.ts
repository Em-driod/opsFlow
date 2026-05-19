import express from 'express';
import { listAssets, createAsset, updateAsset, deleteAsset } from '../controllers/capitalAssetController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/').get(protect, listAssets).post(protect, createAsset);
router.route('/:id').put(protect, updateAsset).delete(protect, deleteAsset);

export default router;
