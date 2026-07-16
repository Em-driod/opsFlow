import mongoose from 'mongoose';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import Transaction from '../models/Transaction.js';

export const globalSearchForBusiness = async (businessId: mongoose.Types.ObjectId, query: string) => {
  const q = query.trim();
  if (!q || q.length < 2) return { clients: [], invoices: [], transactions: [] };

  const regex = new RegExp(q, 'i');
  const limit = 5;

  const [clients, invoices, transactions] = await Promise.all([
    Client.find({ businessId, $or: [{ name: regex }, { email: regex }, { phone: regex }] })
      .select('name email phone')
      .limit(limit)
      .lean(),
    Invoice.find({ businessId, $or: [{ invoiceNumber: regex }, { clientName: regex }, { status: regex }] })
      .select('invoiceNumber clientName total status')
      .limit(limit)
      .lean(),
    Transaction.find({ businessId, $or: [{ description: regex }, { category: regex }] })
      .select('description amount type category date')
      .sort({ date: -1 })
      .limit(limit)
      .lean(),
  ]);

  return { clients, invoices, transactions };
};
