import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as projectService from '../services/projectService.js';

// @desc    Create a new project
// @route   POST /api/projects
// @access  Private
export const createProject = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const project = await projectService.createProjectForBusiness(req.user, req.body);
  res.status(201).json(project);
});

// @desc    Get all projects for business
// @route   GET /api/projects
// @access  Private
export const getProjects = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const projects = await projectService.getProjectsForBusiness(req.user.businessId);
  res.json(projects);
});

// @desc    Update a project
// @route   PUT /api/projects/:id
// @access  Private
export const updateProject = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const project = await projectService.updateProjectForBusiness(req.params.id!, req.user.businessId, req.body);
  res.json(project);
});

// @desc    Delete a project
// @route   DELETE /api/projects/:id
// @access  Private
export const deleteProject = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await projectService.deleteProjectForBusiness(req.params.id!, req.user.businessId);
  res.json({ message: 'Project deleted' });
});

// @desc    Get a single project with computed P&L
// @route   GET /api/projects/:id
// @access  Private
export const getProjectDetail = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await projectService.getProjectDetailForBusiness(req.params.id!, req.user.businessId);
  res.json(result);
});

// @desc    Get team utilization across active projects
// @route   GET /api/projects/team/utilization
// @access  Private
export const getTeamUtilization = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await projectService.getTeamUtilizationForBusiness(req.user.businessId);
  res.json(result);
});
