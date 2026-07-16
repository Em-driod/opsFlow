import mongoose from 'mongoose';
import crypto from 'crypto';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import Proposal from '../models/Proposal.js';
import { enqueue } from './exportQueueService.js';
import { fire } from './webhookService.js';
import { emitToBusiness } from './socketService.js';
import { AppError } from '../utils/AppError.js';

const assertEmailNotTaken = async (
  businessId: mongoose.Types.ObjectId,
  email: string | undefined,
  excludeClientId?: string,
) => {
  if (!email) return;
  const filter: Record<string, unknown> = { businessId, email };
  if (excludeClientId) filter._id = { $ne: excludeClientId };
  const existing = await Client.findOne(filter).select('name');
  if (existing) {
    throw new AppError(`You already have a client with this email — ${existing.name}.`, 400);
  }
};

export const createClient = async (
  businessId: mongoose.Types.ObjectId,
  params: { name: string; email?: string; phone?: string; businessValue?: number; status?: string },
) => {
  await assertEmailNotTaken(businessId, params.email);
  const client = await Client.create({ ...params, businessId });

  enqueue({ type: 'client', action: 'created', data: client.toObject(), businessId: String(businessId) });
  fire('client.created', String(businessId), client.toObject());
  emitToBusiness(String(businessId), 'data_updated', { type: 'client', action: 'created' });

  return client;
};

export const getClientsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { page?: string; limit?: string; search?: string },
) => {
  const pageNum = Math.max(1, parseInt(String(params.page || '1')));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(params.limit || '50'))));
  const skip = (pageNum - 1) * pageSize;

  const filter: Record<string, unknown> = { businessId };
  if (params.search) {
    const re = new RegExp(String(params.search), 'i');
    filter.$or = [{ name: re }, { email: re }, { phone: re }];
  }

  const [clients, total] = await Promise.all([
    Client.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize),
    Client.countDocuments(filter),
  ]);

  return { data: clients, total, page: pageNum, pages: Math.ceil(total / pageSize) };
};

export const getClientByIdForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const client = await Client.findOne({ _id: id, businessId }).populate('transactions');
  if (!client) throw new AppError('Client not found', 404);
  return client;
};

export const updateClientForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  updates: { name?: string; email?: string; phone?: string; businessValue?: number; status?: string },
) => {
  const client = await Client.findOne({ _id: id, businessId });
  if (!client) throw new AppError('Client not found', 404);

  if (updates.email && updates.email !== client.email) {
    await assertEmailNotTaken(businessId, updates.email, id);
  }

  if (updates.name) client.name = updates.name;
  if (updates.email) client.email = updates.email;
  if (updates.phone) client.phone = updates.phone;
  if (updates.businessValue) client.businessValue = updates.businessValue;
  if (updates.status) client.status = updates.status as 'active' | 'inactive';

  const updatedClient = await client.save();

  enqueue({ type: 'client', action: 'updated', data: updatedClient.toObject(), businessId: String(businessId) });
  fire('client.updated', String(businessId), updatedClient.toObject());
  emitToBusiness(String(businessId), 'data_updated', { type: 'client', action: 'updated' });

  return updatedClient;
};

export const deleteClientForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const client = await Client.findOne({ _id: id, businessId });
  if (!client) throw new AppError('Client not found', 404);

  const [invoiceCount, proposalCount] = await Promise.all([
    Invoice.countDocuments({ clientId: client._id }),
    Proposal.countDocuments({ clientId: client._id }),
  ]);

  if (invoiceCount > 0 || proposalCount > 0) {
    throw new AppError(
      `Cannot delete: this client has ${invoiceCount} invoice${invoiceCount !== 1 ? 's' : ''}${proposalCount > 0 ? ` and ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''}` : ''}. Archive or reassign them first.`,
      400,
    );
  }

  await client.deleteOne();
  emitToBusiness(String(businessId), 'data_updated', { type: 'client', action: 'deleted' });
  return client;
};

export const generatePortalLinkForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const client = await Client.findOne({ _id: id, businessId });
  if (!client) throw new AppError('Client not found', 404);

  if (!client.portalToken) {
    client.portalToken = crypto.randomBytes(24).toString('hex');
    await client.save();
  }

  return client.portalToken;
};

export const getClientPortalByToken = async (token: string) => {
  const client = await Client.findOne({ portalToken: token }).populate<{
    businessId: { name: string; currency: string; profile?: { logoImage?: string; accentColor?: string } } | null;
  }>('businessId', 'name currency profile');
  if (!client) throw new AppError('Portal not found', 404);

  const [invoices, proposals] = await Promise.all([
    Invoice.find({ clientId: client._id }).sort({ createdAt: -1 }),
    Proposal.find({ clientId: client._id, status: { $in: ['sent', 'accepted', 'declined'] } }).sort({ createdAt: -1 }),
  ]);

  const biz = client.businessId;
  return {
    client: { name: client.name, email: client.email },
    business: {
      name: biz?.name,
      currency: biz?.currency || 'NGN',
      logoImage: biz?.profile?.logoImage,
      accentColor: biz?.profile?.accentColor,
    },
    invoices,
    proposals,
  };
};
