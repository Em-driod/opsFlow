import express from 'express';
const router = express.Router();
import {
  registerUser,
  loginUser,
  createStaffUser,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  forgotPassword,
  resetPassword,
  googleAuth,
  googleSignupComplete,
} from '../controllers/userController.js';
import { protect, admin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, registerSchema, googleAuthSchema, googleSignupSchema } from '../middleware/schemas.js';
import { authLimiter, forgotPasswordLimiter } from '../middleware/rateLimiter.js';

router.route('/').get(protect, admin, getUsers);
router.post('/register', authLimiter, validate(registerSchema), registerUser);
router.post('/login', authLimiter, validate(loginSchema), loginUser);
router.post('/google', authLimiter, validate(googleAuthSchema), googleAuth);
router.post('/google/complete', authLimiter, validate(googleSignupSchema), googleSignupComplete);
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/reset-password/:token', authLimiter, resetPassword);
router.post('/staff', protect, admin, createStaffUser);
router
  .route('/:id')
  .get(protect, getUserById)
  .put(protect, updateUser)
  .delete(protect, admin, deleteUser);

export default router;
