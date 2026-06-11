import type { Request, Response } from 'express';
import Proposal from '../models/Proposal.js';
import Invoice from '../models/Invoice.js';
import Counter from '../models/Counter.js';
import Client from '../models/Client.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import { createNotification } from './notificationController.js';
import { sendProposalEmail } from '../services/emailService.js';

const getNextProposalNumber = async (businessId: string): Promise<string> => {
  const COUNTER_ID = `proposals_${businessId}`;
  const exists = await Counter.exists({ _id: COUNTER_ID });
  if (!exists) {
    const existingCount = await Proposal.countDocuments({ businessId });
    try { await Counter.create({ _id: COUNTER_ID, seq: existingCount }); } catch (e: any) { if (e.code !== 11000) throw e; }
  }
  const counter = await Counter.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { new: true },
  );
  return `PROP-${counter!.seq.toString().padStart(4, '0')}`;
};

// GET /api/proposals
export const getProposals = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const { page, limit: limitQ, status } = req.query;
    const filter: any = { businessId };
    if (status) filter.status = status;

    const pageNum = Math.max(1, parseInt(String(page || '1')));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(limitQ || '50'))));
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
    res.json({ data: proposals, total, page: pageNum, pages: Math.ceil(total / pageSize) });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch proposals' });
  }
};

// POST /api/proposals
export const createProposal = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const proposalNumber = await getNextProposalNumber(String(businessId));

    const proposal = await Proposal.create({ ...req.body, businessId, proposalNumber });
    res.status(201).json(proposal);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// PUT /api/proposals/:id
export const updateProposal = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const proposal = await Proposal.findOneAndUpdate(
      { _id: req.params.id, businessId },
      req.body,
      { new: true },
    );
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    res.json(proposal);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// DELETE /api/proposals/:id
export const deleteProposal = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const proposal = await Proposal.findOneAndDelete({ _id: req.params.id, businessId });
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    res.json({ message: 'Proposal deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete proposal' });
  }
};

// POST /api/proposals/:id/send — mark as sent + email client
export const sendProposal = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    const proposal = await Proposal.findOneAndUpdate(
      { _id: req.params.id, businessId },
      { status: 'sent' },
      { new: true },
    ).populate('clientId', 'name email');
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });

    // Send email to client — await to report back whether it succeeded
    const recipientEmail = (proposal.clientId as any)?.email || proposal.recipientEmail;
    let emailSent = false;
    if (recipientEmail) {
      const business = await Business.findById(businessId).select('name currency').lean();
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      emailSent = await sendProposalEmail({
        recipientEmail,
        clientName: (proposal.clientId as any)?.name || proposal.customClientName || 'Valued Client',
        businessName: (business as any)?.name || 'OpsFlow Business',
        proposalNumber: proposal.proposalNumber,
        title: proposal.title,
        total: proposal.total,
        currency: (business as any)?.currency || 'NGN',
        validUntil: proposal.validUntil.toISOString(),
        lineItems: proposal.lineItems as any,
        subtotal: proposal.subtotal,
        tax: proposal.tax,
        ...(proposal.notes ? { notes: proposal.notes } : {}),
        publicLink: `${frontendUrl}/#/proposal/${proposal._id}`,
      }).catch(() => false);
    }

    res.json({ ...proposal.toObject(), emailSent, recipientEmail: recipientEmail || null });
  } catch (err) {
    res.status(500).json({ message: 'Failed to send proposal' });
  }
};

// POST /api/proposals/:id/convert — convert to invoice
export const convertToInvoice = async (req: Request, res: Response) => {
  try {
    const businessId = (req as any).user.businessId;
    // Atomic status check + lock: only one request can win the race
    const proposal = await Proposal.findOneAndUpdate(
      { _id: req.params.id, businessId, status: { $ne: 'converted' } },
      { status: 'converted' },
      { new: false }, // return the ORIGINAL doc so we have the pre-update data
    );
    if (!proposal) {
      // Either not found or already converted
      const exists = await Proposal.exists({ _id: req.params.id, businessId });
      return res.status(exists ? 400 : 404).json({
        message: exists ? 'Already converted' : 'Proposal not found',
      });
    }

    // Build invoice number using the same counter as invoiceController
    const INV_COUNTER_ID = 'invoices';
    const invExists = await Counter.exists({ _id: INV_COUNTER_ID });
    if (!invExists) {
      const existingCount = await Invoice.countDocuments();
      try { await Counter.create({ _id: INV_COUNTER_ID, seq: existingCount }); } catch (e: any) { if (e.code !== 11000) throw e; }
    }
    const invCounter = await Counter.findOneAndUpdate(
      { _id: INV_COUNTER_ID },
      { $inc: { seq: 1 } },
      { new: true },
    );
    const invoiceNumber = `INV-${invCounter!.seq.toString().padStart(4, '0')}`;

    const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : (() => {
      const d = new Date(); d.setDate(d.getDate() + 14); return d;
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

    res.status(201).json({ invoice, proposalId: proposal._id });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ── Public routes (no auth) ──────────────────────────────────────────────────

// GET /api/proposals/public/:id
export const getPublicProposal = async (req: Request, res: Response) => {
  try {
    const proposal = await Proposal.findById(req.params.id)
      .populate('businessId', 'name currency profile')
      .populate('clientId', 'name email');
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    if (!['sent', 'accepted', 'declined'].includes(proposal.status)) {
      return res.status(404).json({ message: 'Proposal not available' });
    }
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch proposal' });
  }
};

// POST /api/proposals/public/:id/accept
export const acceptProposal = async (req: Request, res: Response) => {
  try {
    const { signatureName } = req.body;
    if (!signatureName?.trim()) {
      return res.status(400).json({ message: 'Signature name required' });
    }
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    if (proposal.status !== 'sent') {
      return res.status(400).json({ message: 'Proposal cannot be accepted in its current state' });
    }

    proposal.status = 'accepted';
    proposal.signatureName = signatureName.trim();
    proposal.signedAt = new Date();
    await proposal.save();

    // Notify the business owner
    const adminUser = await User.findOne({ businessId: proposal.businessId, role: 'admin' });
    if (adminUser) {
      createNotification({
        businessId: proposal.businessId,
        userId: adminUser._id,
        message: `Your proposal "${proposal.title}" was accepted by ${signatureName.trim()}.`,
        link: `/proposals`,
      }).catch(() => {});
    }

    res.json({ message: 'Proposal accepted', signatureName: proposal.signatureName, signedAt: proposal.signedAt });
  } catch (err) {
    res.status(500).json({ message: 'Failed to accept proposal' });
  }
};

// POST /api/proposals/public/:id/decline
export const declineProposal = async (req: Request, res: Response) => {
  try {
    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ message: 'Proposal not found' });
    if (proposal.status !== 'sent') {
      return res.status(400).json({ message: 'Proposal cannot be declined in its current state' });
    }
    proposal.status = 'declined';
    await proposal.save();

    // Notify the business owner
    const adminUser = await User.findOne({ businessId: proposal.businessId, role: 'admin' });
    if (adminUser) {
      createNotification({
        businessId: proposal.businessId,
        userId: adminUser._id,
        message: `Your proposal "${proposal.title}" was declined by the client.`,
        link: `/proposals`,
      }).catch(() => {});
    }

    res.json({ message: 'Proposal declined' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to decline proposal' });
  }
};
