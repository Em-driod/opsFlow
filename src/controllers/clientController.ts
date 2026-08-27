import type { Request, Response } from 'express';
import { logActivity, audit, diffFields } from '../utils/activityLogger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as clientService from '../services/clientService.js';

// @desc    Create a new client
// @route   POST /api/clients
// @access  Private
export const createClient = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { name, email, phone, businessValue, status } = req.body;
  const client = await clientService.createClient(req.user.businessId, { name, email, phone, businessValue, status });

  logActivity({ req, action: 'CREATE', resource: 'CLIENT', resourceId: String(client._id), details: { clientName: name, email, phone } }).catch(() => {});

  res.status(201).json(client);
});

// @desc    Get all clients for a business
// @route   GET /api/clients
// @access  Private
export const getClients = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const { page, limit, search } = req.query;
  const result = await clientService.getClientsForBusiness(req.user.businessId, {
    page: page as string,
    limit: limit as string,
    search: search as string,
  });
  res.json(result);
});

// @desc    Get client by ID
// @route   GET /api/clients/:id
// @access  Private
export const getClientById = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const client = await clientService.getClientByIdForBusiness(req.params.id!, req.user.businessId);
  res.json(client);
});

// @desc    Update client
// @route   PUT /api/clients/:id
// @access  Private
export const updateClient = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const before = await clientService.getClientByIdForBusiness(req.params.id!, req.user.businessId);
  const updatedClient = await clientService.updateClientForBusiness(req.params.id!, req.user.businessId, req.body);
  audit({
    req,
    action: 'UPDATE',
    resource: 'CLIENT',
    resourceId: req.params.id,
    summary: `Updated client “${updatedClient.name}”`,
    changes: diffFields(
      before as unknown as Record<string, unknown>,
      updatedClient as unknown as Record<string, unknown>,
      ['name', 'email', 'phone', 'address', 'notes', 'status', 'businessValue'],
    ),
  });
  res.json(updatedClient);
});

// @desc    Delete client
// @route   DELETE /api/clients/:id
// @access  Private
export const deleteClient = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const client = await clientService.deleteClientForBusiness(req.params.id!, req.user.businessId);

  logActivity({ req, action: 'DELETE', resource: 'CLIENT', resourceId: String(client._id), details: { clientName: client.name } }).catch(() => {});

  res.json({ message: 'Client removed' });
});

// POST /api/clients/:id/portal — generate (or return) portal token
export const generatePortalLink = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const token = await clientService.generatePortalLinkForBusiness(req.params.id!, req.user.businessId);
  res.json({ token });
});

// GET /api/clients/portal/:token — public, no auth
export const getClientPortal = asyncHandler(async (req: Request, res: Response) => {
  const result = await clientService.getClientPortalByToken(req.params.token!);
  res.json(result);
});
