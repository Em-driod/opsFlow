import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Transaction from '../models/Transaction.js';
import Invoice from '../models/Invoice.js';
import User from '../models/User.js';
import { emitToBusiness } from './socketService.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

export const createProjectForBusiness = async (
  user: IUser,
  params: { name: string; description?: string; clientId?: string; budget?: number },
) => {
  const { name, description, clientId, budget } = params;
  const businessId = user.businessId;

  const project = await Project.create({
    name,
    description,
    clientId,
    businessId,
    budget,
    teamMembers: [user._id],
  });

  emitToBusiness(String(businessId), 'data_updated', { type: 'project', action: 'created' });

  return project;
};

export const getProjectsForBusiness = (businessId: mongoose.Types.ObjectId) =>
  Project.find({ businessId }).populate('clientId', 'name').populate('teamMembers', 'name').sort({ createdAt: -1 });

const sanitizeProjectPayload = (body: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  if (typeof body.name === 'string') out.name = body.name.trim();
  if (typeof body.description === 'string') out.description = body.description;
  if (body.clientId === null || body.clientId === '') out.clientId = null;
  else if (typeof body.clientId === 'string' && mongoose.Types.ObjectId.isValid(body.clientId)) out.clientId = body.clientId;
  if (typeof body.budget === 'number' && body.budget >= 0) out.budget = body.budget;
  if (typeof body.status === 'string' && ['planning', 'active', 'completed', 'on_hold'].includes(body.status)) out.status = body.status;
  if (Array.isArray(body.teamMembers)) {
    out.teamMembers = body.teamMembers.filter(
      (id: unknown): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id),
    );
  }
  return out;
};

export const updateProjectForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  body: Record<string, unknown>,
) => {
  const data = sanitizeProjectPayload(body);

  const project = await Project.findOneAndUpdate({ _id: id, businessId }, { $set: data }, { new: true })
    .populate('clientId', 'name')
    .populate('teamMembers', 'name');

  if (!project) throw new AppError('Project not found', 404);

  emitToBusiness(String(businessId), 'data_updated', { type: 'project', action: 'updated' });
  return project;
};

export const deleteProjectForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const project = await Project.findOneAndDelete({ _id: id, businessId });
  if (!project) throw new AppError('Project not found', 404);

  emitToBusiness(String(businessId), 'data_updated', { type: 'project', action: 'deleted' });
};

export const getProjectDetailForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const project = await Project.findOne({ _id: id, businessId })
    .populate('clientId', 'name')
    .populate('teamMembers', 'name email role');

  if (!project) throw new AppError('Project not found', 404);

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

  return {
    project,
    pnl: { revenue, expenses, profit, margin, budget, budgetUtilization, invoicedTotal, paidTotal, outstanding: invoicedTotal - paidTotal },
  };
};

export const getTeamUtilizationForBusiness = async (businessId: mongoose.Types.ObjectId) => {
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

  return { utilization, totalActiveProjects: projects.length };
};
