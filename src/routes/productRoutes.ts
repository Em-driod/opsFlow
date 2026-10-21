import express from 'express';
const router = express.Router();
import { getProducts, createProduct, updateProduct, deleteProduct, renameCategory } from '../controllers/productController.js';
import { protect } from '../middleware/auth.js';

router.route('/').get(protect, getProducts).post(protect, createProduct);
router.post('/categories/rename', protect, renameCategory);
router.route('/:id').put(protect, updateProduct).delete(protect, deleteProduct);

export default router;
