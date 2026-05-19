import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Transaction from '../models/Transaction.js';
import Invoice from '../models/Invoice.js';
import User from '../models/User.js';
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
      .populate('teamMembers', 'name')
      .sort({ createdAt: -1 });
    res.json(projects);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

const sanitizeProjectPayload = (body: any) => {
  const out: any = {};
  if (typeof body.name === 'string') out.name = body.name.trim();
  if (typeof body.description === 'string') out.description = body.description;
  if (body.clientId === null || body.clientId === '') out.clientId = null;
  else if (typeof body.clientId === 'string' && mongoose.Types.ObjectId.isValid(body.clientId)) out.clientId = body.clientId;
  if (typeof body.budget === 'number' && body.budget >= 0) out.budget = body.budget;
  if (['planning', 'active', 'completed', 'on_hold'].includes(body.status)) out.status = body.status;
  if (Array.isArray(body.teamMembers)) {
    out.teamMembers = body.teamMembers.filter(
      (id: any) => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id),
    );
  }
  return out;
};

// @desc    Update a project
// @route   PUT /api/projects/:id
// @access  Private
export const updateProject = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const data = sanitizeProjectPayload(req.body);

    const project = await Project.findOneAndUpdate(
      { _id: req.params.id, businessId },
      { $set: data },
      { new: true },
    )
      .populate('clientId', 'name')
      .populate('teamMembers', 'name');

    if (!project) return res.status(404).json({ message: 'Project not found' });

    emitToBusiness(String(businessId), 'data_updated', { type: 'project', action: 'updated' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

// @desc    Delete a project
// @route   DELETE /api/projects/:id
// @access  Private
export const deleteProject = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const project = await Project.findOneAndDelete({ _id: req.params.id, businessId });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    emitToBusiness(String(businessId), 'data_updated', { type: 'project', action: 'deleted' });
    res.json({ message: 'Project deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

// @desc    Get a single project with computed P&L
// @route   GET /api/projects/:id
// @access  Private
export const getProjectDetail = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const project = await Project.findOne({ _id: req.params.id, businessId })
      .populate('clientId', 'name')
      .populate('teamMembers', 'name email role');

    if (!project) return res.status(404).json({ message: 'Project not found' });

    let revenue = 0;
    let expenses = 0;
    let invoicedTotal = 0;
    let paidTotal = 0;

    const businessObjectId = new mongoose.Types.ObjectId(String(businessId));
    const projectObjectId = new mongoose.Types.ObjectId(String(project._id));

    const txAgg = await Transaction.aggregate([
      { $match: { businessId: businessObjectId, projectId: projectObjectId } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]);
    for (const row of txAgg) {
      if (row._id === 'income') revenue = row.total;
      if (row._id === 'expense') expenses = row.total;
    }

    if (project.clientId) {
      const invAgg = await Invoice.aggregate([
        { $match: { businessId: businessObjectId, clientId: project.clientId._id } },
        { $group: { _id: '$status', total: { $sum: '$total' } } },
      ]);
      for (const row of invAgg) {
        invoicedTotal += row.total;
        if (row._id === 'paid') paidTotal += row.total;
      }
    }

    const budget = project.budget || 0;
    const profit = revenue - expenses;
    const margin = revenue > 0 ? profit / revenue : 0;
    const budgetUtilization = budget > 0 ? expenses / budget : 0;

    res.json({
      project,
      pnl: {
        revenue,
        expenses,
        profit,
        margin,
        budget,
        budgetUtilization,
        invoicedTotal,
        paidTotal,
        outstanding: invoicedTotal - paidTotal,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

// @desc    Get team utilization across active projects
// @route   GET /api/projects/team/utilization
// @access  Private
export const getTeamUtilization = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;

    const [users, projects] = await Promise.all([
      User.find({ businessId }).select('name email role'),
      Project.find({ businessId, status: { $in: ['active', 'planning'] } }).select('name teamMembers status'),
    ]);

    const utilization = users.map((user) => {
      const userId = String(user._id);
      const assigned = projects.filter((p) => p.teamMembers.some((tm) => String(tm) === userId));
      return {
        userId,
        name: user.name,
        email: user.email,
        role: user.role,
        activeProjects: assigned.map((p) => ({ id: p._id, name: p.name, status: p.status })),
        load: assigned.length,
      };
    });

    res.json({ utilization, totalActiveProjects: projects.length });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
