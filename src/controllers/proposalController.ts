import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import { audit } from '../utils/activityLogger.js';
import * as proposalService from '../services/proposalService.js';

// GET /api/proposals
export const getProposals = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { page, limit, status } = req.query;
  const result = await proposalService.getProposalsForBusiness(req.user.businessId, {
    page: page as string,
    limit: limit as string,
    status: status as string,
  });
  res.json(result);
});

// POST /api/proposals
export const createProposal = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const proposal = await proposalService.createProposalForBusiness(req.user.businessId, req.body);
  audit({
    req,
    action: 'CREATE',
    resource: 'PROPOSAL',
    resourceId: String(proposal._id),
    details: { proposalNumber: proposal.proposalNumber, title: proposal.title, total: proposal.total },
  });
  res.status(201).json(proposal);
});

// PUT /api/proposals/:id
export const updateProposal = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const proposal = await proposalService.updateProposalForBusiness(req.params.id!, req.user.businessId, req.body);
  res.json(proposal);
});

// DELETE /api/proposals/:id
export const deleteProposal = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  await proposalService.deleteProposalForBusiness(req.params.id!, req.user.businessId);
  audit({ req, action: 'DELETE', resource: 'PROPOSAL', resourceId: req.params.id });
  res.json({ message: 'Proposal deleted' });
});

// POST /api/proposals/:id/send — mark as sent + email client
export const sendProposal = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await proposalService.sendProposalForBusiness(req.params.id!, req.user.businessId);
  audit({ req, action: 'SEND', resource: 'PROPOSAL', resourceId: req.params.id });
  res.json(result);
});

// POST /api/proposals/:id/convert — convert to invoice
export const convertToInvoice = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const result = await proposalService.convertProposalToInvoice(req.params.id!, req.user.businessId, req.body.dueDate);
  res.status(201).json(result);
});

// ── Public routes (no auth) ──────────────────────────────────────────────────

// GET /api/proposals/public/:id
export const getPublicProposal = asyncHandler(async (req: Request, res: Response) => {
  const proposal = await proposalService.getPublicProposalById(req.params.id!);
  res.json(proposal);
});

// POST /api/proposals/public/:id/accept
export const acceptProposal = asyncHandler(async (req: Request, res: Response) => {
  const result = await proposalService.acceptPublicProposal(req.params.id!, req.body.signatureName);
  res.json({ message: 'Proposal accepted', ...result });
});

// POST /api/proposals/public/:id/decline
export const declineProposal = asyncHandler(async (req: Request, res: Response) => {
  await proposalService.declinePublicProposal(req.params.id!);
  res.json({ message: 'Proposal declined' });
});
