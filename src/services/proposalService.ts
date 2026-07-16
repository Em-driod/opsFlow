import mongoose from 'mongoose';
import Proposal from '../models/Proposal.js';
import Invoice from '../models/Invoice.js';
import Counter from '../models/Counter.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import { createNotification } from './notificationService.js';
import { sendProposalEmail } from './emailService.js';
import { AppError } from '../utils/AppError.js';

const getNextProposalNumber = async (businessId: string): Promise<string> => {
  const COUNTER_ID = `proposals_${businessId}`;
  const exists = await Counter.exists({ _id: COUNTER_ID });
  if (!exists) {
    const existingCount = await Proposal.countDocuments({ businessId });
    try {
      await Counter.create({ _id: COUNTER_ID, seq: existingCount });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  const counter = await Counter.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { seq: 1 } }, { new: true });
  return `PROP-${counter!.seq.toString().padStart(4, '0')}`;
};

export const getProposalsForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { page?: string; limit?: string; status?: string },
) => {
  const filter: Record<string, unknown> = { businessId };
  if (params.status) filter.status = params.status;

  const pageNum = Math.max(1, parseInt(String(params.page || '1')));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(params.limit || '50'))));
  const skip = (pageNum - 1) * pageSize;

  const [proposals, total] = await Promise.all([
    Proposal.find(filter)
      .populate('clientId', 'name email')
      .populate('convertedInvoiceId', 'invoiceNumber')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize),
    Proposal.countDocuments(filter),
  ]);
  return { data: proposals, total, page: pageNum, pages: Math.ceil(total / pageSize) };
};

export const createProposalForBusiness = async (businessId: mongoose.Types.ObjectId, body: Record<string, unknown>) => {
  try {
    const proposalNumber = await getNextProposalNumber(String(businessId));
    return await Proposal.create({ ...body, businessId, proposalNumber });
  } catch (err) {
    throw new AppError((err as Error).message, 400);
  }
};

export const updateProposalForBusiness = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  body: Record<string, unknown>,
) => {
  try {
    const proposal = await Proposal.findOneAndUpdate({ _id: id, businessId }, body, { new: true });
    if (!proposal) throw new AppError('Proposal not found', 404);
    return proposal;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError((err as Error).message, 400);
  }
};

export const deleteProposalForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const proposal = await Proposal.findOneAndDelete({ _id: id, businessId });
  if (!proposal) throw new AppError('Proposal not found', 404);
};

export const sendProposalForBusiness = async (id: string, businessId: mongoose.Types.ObjectId) => {
  const proposal = await Proposal.findOneAndUpdate({ _id: id, businessId }, { status: 'sent' }, { new: true }).populate<{
    clientId: { name: string; email: string } | null;
  }>('clientId', 'name email');
  if (!proposal) throw new AppError('Proposal not found', 404);

  const recipientEmail = proposal.clientId?.email || proposal.recipientEmail;
  let emailSent = false;
  if (recipientEmail) {
    const business = await Business.findById(businessId).select('name currency').lean();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    emailSent = await sendProposalEmail({
      recipientEmail,
      clientName: proposal.clientId?.name || proposal.customClientName || 'Valued Client',
      businessName: business?.name || 'OpsFlow Business',
      proposalNumber: proposal.proposalNumber,
      title: proposal.title,
      total: proposal.total,
      currency: business?.currency || 'NGN',
      validUntil: proposal.validUntil.toISOString(),
      lineItems: proposal.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        total: li.total,
      })),
      subtotal: proposal.subtotal,
      tax: proposal.tax,
      ...(proposal.notes ? { notes: proposal.notes } : {}),
      publicLink: `${frontendUrl}/proposal/${proposal._id}`,
    }).catch(() => false);
  }

  return { ...proposal.toObject(), emailSent, recipientEmail: recipientEmail || null };
};

export const convertProposalToInvoice = async (
  id: string,
  businessId: mongoose.Types.ObjectId,
  dueDateRaw?: string,
) => {
  // Atomic status check + lock: only one request can win the race
  const proposal = await Proposal.findOneAndUpdate(
    { _id: id, businessId, status: { $ne: 'converted' } },
    { status: 'converted' },
    { new: false }, // return the ORIGINAL doc so we have the pre-update data
  );
  if (!proposal) {
    const exists = await Proposal.exists({ _id: id, businessId });
    throw new AppError(exists ? 'Already converted' : 'Proposal not found', exists ? 400 : 404);
  }

  const INV_COUNTER_ID = 'invoices';
  const invExists = await Counter.exists({ _id: INV_COUNTER_ID });
  if (!invExists) {
    const existingCount = await Invoice.countDocuments();
    try {
      await Counter.create({ _id: INV_COUNTER_ID, seq: existingCount });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  const invCounter = await Counter.findOneAndUpdate({ _id: INV_COUNTER_ID }, { $inc: { seq: 1 } }, { new: true });
  const invoiceNumber = `INV-${invCounter!.seq.toString().padStart(4, '0')}`;

  const dueDate = dueDateRaw
    ? new Date(dueDateRaw)
    : (() => {
        const d = new Date();
        d.setDate(d.getDate() + 14);
        return d;
      })();

  const invoice = await Invoice.create({
    invoiceNumber,
    businessId,
    clientId: proposal.clientId,
    customClientName: proposal.customClientName,
    recipientEmail: proposal.recipientEmail,
    lineItems: proposal.lineItems,
    subtotal: proposal.subtotal,
    tax: proposal.tax,
    total: proposal.total,
    notes: proposal.notes,
    dueDate,
    status: 'draft',
  });

  await Proposal.findByIdAndUpdate(proposal._id, { convertedInvoiceId: invoice._id });

  return { invoice, proposalId: proposal._id };
};

export const getPublicProposalById = async (id: string) => {
  const proposal = await Proposal.findById(id).populate('businessId', 'name currency profile').populate('clientId', 'name email');
  if (!proposal) throw new AppError('Proposal not found', 404);
  if (!['sent', 'accepted', 'declined'].includes(proposal.status)) {
    throw new AppError('Proposal not available', 404);
  }
  return proposal;
};

export const acceptPublicProposal = async (id: string, signatureName: string) => {
  if (!signatureName?.trim()) throw new AppError('Signature name required', 400);

  const proposal = await Proposal.findById(id);
  if (!proposal) throw new AppError('Proposal not found', 404);
  if (proposal.status !== 'sent') throw new AppError('Proposal cannot be accepted in its current state', 400);

  proposal.status = 'accepted';
  proposal.signatureName = signatureName.trim();
  proposal.signedAt = new Date();
  await proposal.save();

  const adminUser = await User.findOne({ businessId: proposal.businessId, role: 'admin' });
  if (adminUser) {
    createNotification({
      businessId: proposal.businessId,
      userId: adminUser._id as mongoose.Types.ObjectId,
      message: `Your proposal "${proposal.title}" was accepted by ${signatureName.trim()}.`,
      link: `/proposals`,
    }).catch(() => {});
  }

  return { signatureName: proposal.signatureName, signedAt: proposal.signedAt };
};

export const declinePublicProposal = async (id: string) => {
  const proposal = await Proposal.findById(id);
  if (!proposal) throw new AppError('Proposal not found', 404);
  if (proposal.status !== 'sent') throw new AppError('Proposal cannot be declined in its current state', 400);

  proposal.status = 'declined';
  await proposal.save();

  const adminUser = await User.findOne({ businessId: proposal.businessId, role: 'admin' });
  if (adminUser) {
    createNotification({
      businessId: proposal.businessId,
      userId: adminUser._id as mongoose.Types.ObjectId,
      message: `Your proposal "${proposal.title}" was declined by the client.`,
      link: `/proposals`,
    }).catch(() => {});
  }
};
