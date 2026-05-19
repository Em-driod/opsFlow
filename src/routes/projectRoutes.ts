import express from 'express';
import {
  createProject,
  getProjects,
  updateProject,
  deleteProject,
  getProjectDetail,
  getTeamUtilization,
} from '../controllers/projectController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.route('/').post(protect, createProject).get(protect, getProjects);
router.get('/team/utilization', protect, getTeamUtilization);
router.route('/:id').get(protect, getProjectDetail).put(protect, updateProject).delete(protect, deleteProject);

export default router;
