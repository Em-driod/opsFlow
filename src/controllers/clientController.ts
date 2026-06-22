import type { Request, Response } from 'express';
import Client from '../models/Client.js';
import Business from '../models/Business.js';
import Invoice from '../models/Invoice.js';
import Proposal from '../models/Proposal.js';
import { enqueue } from '../services/exportQueueService.js';
import { fire } from '../services/webhookService.js';
import { emitToBusiness } from '../services/socketService.js';
import crypto from 'crypto';

// @desc    Create a new client
// @route   POST /api/clients
// @access  Private
export const createClient = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, businessValue, status } = req.body;

    const client = await Client.create({
      name,
      email,
      phone,
      businessValue,
      status,
      businessId: (req.user as any).businessId,
    });

    enqueue({ type: 'client', action: 'created', data: client.toObject(), businessId: String((req.user as any).businessId) });
    fire('client.created', String((req.user as any).businessId), client.toObject());
    emitToBusiness(String((req.user as any).businessId), 'data_updated', { type: 'client', action: 'created' });

    res.status(201).json(client);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error creating client:', error);
  }
};

// @desc    Get all clients for a business
// @route   GET /api/clients
// @access  Private
export const getClients = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    const { page, limit: limitQ, search } = req.query;

    const pageNum = Math.max(1, parseInt(String(page || '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(limitQ || '50'))));
    const skip = (pageNum - 1) * pageSize;

    const filter: Record<string, unknown> = { businessId };
    if (search) {
      const re = new RegExp(String(search), 'i');
      filter.$or = [{ name: re }, { email: re }, { phone: re }];
    }

    const [clients, total] = await Promise.all([
      Client.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize),
      Client.countDocuments(filter),
    ]);

    res.json({ data: clients, total, page: pageNum, pages: Math.ceil(total / pageSize) });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};

// @desc    Get client by ID
// @route   GET /api/clients/:id
// @access  Private
export const getClientById = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    }).populate('transactions'); // Filter by businessId
    if (client) {
      res.json(client);
    } else {
      res.status(404).json({ message: 'Client not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error fetching client by ID:', error);
  }
};

// @desc    Update client
// @route   PUT /api/clients/:id
// @access  Private
export const updateClient = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });
    if (client) {
      client.name = req.body.name || client.name;
      client.email = req.body.email || client.email;
      client.phone = req.body.phone || client.phone;
      client.businessValue = req.body.businessValue || client.businessValue;
      client.status = req.body.status || client.status;

      const updatedClient = await client.save();

      enqueue({ type: 'client', action: 'updated', data: updatedClient.toObject(), businessId: String((req.user as any).businessId) });
      fire('client.updated', String((req.user as any).businessId), updatedClient.toObject());
      emitToBusiness(String((req.user as any).businessId), 'data_updated', { type: 'client', action: 'updated' });

      res.json(updatedClient);
    } else {
      res.status(404).json({ message: 'Client not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error updating client:', error);
  }
};

// @desc    Delete client
// @route   DELETE /api/clients/:id
// @access  Private
export const deleteClient = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    }); // Filter by businessId
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const [invoiceCount, proposalCount] = await Promise.all([
      Invoice.countDocuments({ clientId: client._id }),
      Proposal.countDocuments({ clientId: client._id }),
    ]);

    if (invoiceCount > 0 || proposalCount > 0) {
      return res.status(400).json({
        message: `Cannot delete: this client has ${invoiceCount} invoice${invoiceCount !== 1 ? 's' : ''}${proposalCount > 0 ? ` and ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''}` : ''}. Archive or reassign them first.`,
      });
    }

    await client.deleteOne();
    emitToBusiness(String((req.user as any).businessId), 'data_updated', { type: 'client', action: 'deleted' });
    res.json({ message: 'Client removed' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error deleting client:', error);
  }
};

// POST /api/clients/:id/portal — generate (or return) portal token
export const generatePortalLink = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    if (!client.portalToken) {
      client.portalToken = crypto.randomBytes(24).toString('hex');
      await client.save();
    }

    res.json({ token: client.portalToken });
  } catch {
    res.status(500).json({ message: 'Failed to generate portal link' });
  }
};

// GET /api/clients/portal/:token — public, no auth
export const getClientPortal = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({ portalToken: req.params.token })
      .populate('businessId', 'name currency profile');
    if (!client) return res.status(404).json({ message: 'Portal not found' });

    const [invoices, proposals] = await Promise.all([
      Invoice.find({ clientId: client._id }).sort({ createdAt: -1 }),
      Proposal.find({ clientId: client._id, status: { $in: ['sent', 'accepted', 'declined'] } }).sort({ createdAt: -1 }),
    ]);

    const biz = client.businessId as any;
    res.json({
      client: { name: client.name, email: client.email },
      business: {
        name: biz?.name,
        currency: biz?.currency || 'NGN',
        logoImage: biz?.profile?.logoImage,
        accentColor: biz?.profile?.accentColor,
      },
      invoices,
      proposals,
    });
  } catch {
    res.status(500).json({ message: 'Failed to load portal' });
  }
};
