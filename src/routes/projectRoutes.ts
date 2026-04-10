import express from 'express';
import { createProject, getProjects } from '../controllers/projectController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/').post(protect, createProject).get(protect, getProjects);

export default router;
