import type { Request, Response } from 'express';
import Project from '../models/Project.js';
import { emitToBusiness } from '../services/socketService.js';

// @desc    Create a new project
// @route   POST /api/projects
// @access  Private
export const createProject = async (req: Request, res: Response) => {
  try {
    const { name, description, clientId, budget } = req.body;
    const businessId = (req.user as any).businessId;

    const project = await Project.create({
      name,
      description,
      clientId,
      businessId,
      budget,
      teamMembers: [(req.user as any)._id] // Creator is initial member
    });

    emitToBusiness(String(businessId), 'data_updated', { type: 'project', action: 'created' });

    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

// @desc    Get all projects for business
// @route   GET /api/projects
// @access  Private
export const getProjects = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const projects = await Project.find({ businessId })
      .populate('clientId', 'name')
      .populate('teamMembers', 'name');
    res.json(projects);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
