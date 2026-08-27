import express from 'express';
const router = express.Router();
import { getProducts, createProduct, updateProduct, deleteProduct } from '../controllers/productController.js';
import { protect } from '../middleware/auth.js';
import { permit } from '../middleware/permit.js';

router.route('/').get(protect, getProducts).post(protect, createProduct);
router.route('/:id').put(protect, updateProduct).delete(protect, permit('admin'), deleteProduct);

export default router;
