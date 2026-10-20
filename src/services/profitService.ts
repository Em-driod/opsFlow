import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import Receipt from '../models/Receipt.js';
import Product from '../models/Product.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex } from '../utils/regex.js';

// ─────────────────────────────────────────────────────────────────────────────
// Product profit
//
// Sales come from two places: invoice line items and receipt items. Each line
// that points at a catalog product is costed with the unit cost captured when
// the sale was made (utils/productCost.ts), falling back to the product's
// current cost price for sales made before one was set.
//
// Invoices can be part-paid, so every line carries three views of profit:
//   booked      — the full profit if the invoice is paid in full
//   collected   — the share of that profit actually received so far
//   outstanding — booked − collected (still owed by the customer)
//
// How a part-payment splits between cost and profit is the `method`:
//   proportional (default) — every payment is the same mix of cost and profit
//                            as the invoice as a whole (40% paid → 40% of the
//                            profit collected).
//   cost_first             — payments recover the cost first; profit is only
//                            counted once the cost is covered. More cautious.
//
// The paid share is amountPaid / invoice.total (tax included), applied to the
// line totals (tax excluded) — tax collected isn't profit.
// ─────────────────────────────────────────────────────────────────────────────

export type ProfitMethod = 'proportional' | 'cost_first';

const round = (n: number) => Math.round(n * 100) / 100;
const normaliseDescription = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

interface Line {
  productId: string | null;
  description: string;
  quantity: number;
  revenue: number;
  unitCost: number | null;
  // Filled in by allocate()
  cost: number;
  profit: number;
  collectedRevenue: number;
  collectedProfit: number;
}

interface SaleDoc {
  source: 'invoice' | 'receipt';
  id: string;
  number: string;
  date: Date;
  customer: string;
  status: string;
  paidRatio: number;
  lines: Line[];
}

const costKnown = (l: Line) => l.unitCost !== null;

// Splits a document's collected money across its lines, per the chosen method.
const allocate = (doc: SaleDoc, method: ProfitMethod) => {
  const r = doc.paidRatio;
  for (const l of doc.lines) {
    l.cost = costKnown(l) ? round(l.unitCost! * l.quantity) : 0;
    l.profit = costKnown(l) ? round(l.revenue - l.cost) : 0;
    l.collectedRevenue = round(l.revenue * r);
    l.collectedProfit = costKnown(l) ? round(l.profit * r) : 0;
  }

  if (method !== 'cost_first' || r >= 1) return;

  const costed = doc.lines.filter(costKnown);
  const docProfit = costed.reduce((s, l) => s + l.profit, 0);
  // A loss-making sale has no profit to defer — keep the proportional split.
  if (docProfit <= 0) return;

  const docCost = costed.reduce((s, l) => s + l.cost, 0);
  const collected = costed.reduce((s, l) => s + l.revenue, 0) * r;
  const collectedProfit = Math.min(docProfit, Math.max(0, collected - docCost));
  for (const l of costed) l.collectedProfit = round(collectedProfit * (l.profit / docProfit));
};

const invoicePaidRatio = (inv: { total: number; status: string; payments?: { amount: number }[] }) => {
  const recorded = (inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  // Invoices marked paid before payments were logged have no entries — treat as paid in full.
  const amountPaid = recorded > 0 ? recorded : inv.status === 'paid' ? inv.total : 0;
  if (inv.total > 0) return Math.min(1, amountPaid / inv.total);
  return amountPaid > 0 || inv.status === 'paid' ? 1 : 0;
};

const dateRange = (from?: string, to?: string) => {
  const range: { $gte?: Date; $lte?: Date } = {};
  if (from) {
    const d = new Date(`${from}T00:00:00.000Z`);
    if (isNaN(d.getTime())) throw new AppError('Invalid "from" date', 400);
    range.$gte = d;
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999Z`);
    if (isNaN(d.getTime())) throw new AppError('Invalid "to" date', 400);
    range.$lte = d;
  }
  return Object.keys(range).length ? range : null;
};

const loadSales = async (
  businessId: mongoose.Types.ObjectId,
  params: { from?: string; to?: string; source?: string },
): Promise<SaleDoc[]> => {
  const range = dateRange(params.from, params.to);
  const wantInvoices = params.source !== 'receipts';
  const wantReceipts = params.source !== 'invoices';

  const [invoices, receipts, invoicePaymentTxIds] = await Promise.all([
    wantInvoices
      ? Invoice.find({ businessId, status: { $ne: 'void' }, ...(range ? { createdAt: range } : {}) })
          .select('+lineItems.unitCost')
          .populate('clientId', 'name')
          .lean()
      : [],
    wantReceipts
      ? Receipt.find({ businessId, ...(range ? { date: range } : {}) })
          .select('+items.unitCost')
          .lean()
      : [],
    // A receipt line built from an invoice-payment transaction re-states money
    // already counted on the invoice — collect those ids so it isn't counted twice.
    wantReceipts
      ? Invoice.distinct('payments.transactionId', { businessId }).then((ids) => new Set(ids.map(String)))
      : new Set<string>(),
  ]);

  const docs: SaleDoc[] = [];

  for (const inv of invoices) {
    const client = inv.clientId as unknown as { name?: string } | null;
    docs.push({
      source: 'invoice',
      id: String(inv._id),
      number: inv.invoiceNumber,
      date: (inv as unknown as { createdAt: Date }).createdAt,
      customer: client?.name || inv.customClientName || '',
      status: inv.status,
      paidRatio: invoicePaidRatio(inv),
      lines: (inv.lineItems || []).map((li) => ({
        productId: li.productId ? String(li.productId) : null,
        description: li.description || '',
        quantity: Number(li.quantity) || 0,
        revenue: Number(li.total) || 0,
        unitCost: typeof li.unitCost === 'number' ? li.unitCost : null,
        cost: 0,
        profit: 0,
        collectedRevenue: 0,
        collectedProfit: 0,
      })),
    });
  }

  for (const rc of receipts) {
    const receiptTxIds = (rc.transactionIds || []).map(String);
    const restatesInvoicePayment = receiptTxIds.some((id) => invoicePaymentTxIds.has(id));
    const lines = (rc.items || [])
      .filter((it) => {
        if (it.transactionId) return !invoicePaymentTxIds.has(String(it.transactionId));
        // Older receipts didn't record which line came from which transaction.
        // If the receipt was issued for an invoice payment, only its catalog
        // lines can be separate sales.
        return !(restatesInvoicePayment && !it.productId);
      })
      .map((it) => ({
        productId: it.productId ? String(it.productId) : null,
        description: it.description || '',
        quantity: Number(it.quantity) || 1,
        revenue: Number(it.amount) || 0,
        unitCost: typeof it.unitCost === 'number' ? it.unitCost : null,
        cost: 0,
        profit: 0,
        collectedRevenue: 0,
        collectedProfit: 0,
      }));
    if (lines.length === 0) continue;
    docs.push({
      source: 'receipt',
      id: String(rc._id),
      number: rc.receiptNumber,
      date: rc.date,
      customer: rc.payerName || '',
      status: 'paid',
      paidRatio: 1, // a receipt is money already received
      lines,
    });
  }

  return docs;
};

interface ProductRow {
  productId: string;
  name: string;
  category: string | null;
  unit: string | null;
  price: number | null;
  currentCostPrice: number | null;
  isActive: boolean;
  unitsSold: number;
  salesCount: number;
  revenue: number;
  costedRevenue: number;
  cost: number;
  profit: number;
  margin: number | null;
  collectedRevenue: number;
  collectedProfit: number;
  outstandingRevenue: number;
  outstandingProfit: number;
  missingCostUnits: number;
  missingCostRevenue: number;
  lastSoldAt: Date | null;
}

export const getProductProfitForBusiness = async (
  businessId: mongoose.Types.ObjectId,
  params: { from?: string; to?: string; source?: string; method?: string; productId?: string },
) => {
  const method: ProfitMethod = params.method === 'cost_first' ? 'cost_first' : 'proportional';
  const docs = await loadSales(businessId, params);

  const productIds = [...new Set(docs.flatMap((d) => d.lines.map((l) => l.productId)).filter(Boolean))] as string[];
  // Inactive (removed) products are included so their past sales still have a name.
  const [products, activeCatalog] = await Promise.all([
    productIds.length
      ? Product.find({ _id: { $in: productIds }, businessId })
          .select('+costPrice name category unit price isActive')
          .lean()
      : [],
    Product.find({ businessId, isActive: true }).select('name').lean(),
  ]);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  // Sales made before a cost was captured fall back to today's cost price.
  // Lines pointing at a product from another business (shouldn't happen) are
  // treated as unlinked rather than trusted.
  for (const doc of docs) {
    for (const l of doc.lines) {
      if (!l.productId) continue;
      const p = productById.get(l.productId);
      if (!p) {
        l.productId = null;
        l.unitCost = null;
        continue;
      }
      if (l.unitCost === null && typeof p.costPrice === 'number') l.unitCost = p.costPrice;
    }
    allocate(doc, method);
  }

  const rows = new Map<string, ProductRow & { docIds: Set<string> }>();
  const unlinked = new Map<
    string,
    { description: string; lines: number; units: number; revenue: number; lastDate: Date; invoices: number; receipts: number }
  >();

  for (const doc of docs) {
    for (const l of doc.lines) {
      if (!l.productId) {
        if (l.revenue === 0 && !l.description.trim()) continue;
        const key = normaliseDescription(l.description);
        const g = unlinked.get(key) ?? {
          description: l.description.trim(),
          lines: 0,
          units: 0,
          revenue: 0,
          lastDate: doc.date,
          invoices: 0,
          receipts: 0,
        };
        g.lines += 1;
        g.units += l.quantity;
        g.revenue += l.revenue;
        if (doc.date > g.lastDate) g.lastDate = doc.date;
        if (doc.source === 'invoice') g.invoices += 1;
        else g.receipts += 1;
        unlinked.set(key, g);
        continue;
      }

      const p = productById.get(l.productId)!;
      const row =
        rows.get(l.productId) ??
        ({
          productId: l.productId,
          name: p.name,
          category: p.category || null,
          unit: p.unit || null,
          price: typeof p.price === 'number' ? p.price : null,
          currentCostPrice: typeof p.costPrice === 'number' ? p.costPrice : null,
          isActive: p.isActive !== false,
          unitsSold: 0,
          salesCount: 0,
          revenue: 0,
          costedRevenue: 0,
          cost: 0,
          profit: 0,
          margin: null,
          collectedRevenue: 0,
          collectedProfit: 0,
          outstandingRevenue: 0,
          outstandingProfit: 0,
          missingCostUnits: 0,
          missingCostRevenue: 0,
          lastSoldAt: null,
          docIds: new Set<string>(),
        } as ProductRow & { docIds: Set<string> });

      row.unitsSold += l.quantity;
      row.revenue += l.revenue;
      row.collectedRevenue += l.collectedRevenue;
      row.docIds.add(`${doc.source}:${doc.id}`);
      if (!row.lastSoldAt || doc.date > row.lastSoldAt) row.lastSoldAt = doc.date;
      if (costKnown(l)) {
        row.costedRevenue += l.revenue;
        row.cost += l.cost;
        row.profit += l.profit;
        row.collectedProfit += l.collectedProfit;
      } else {
        row.missingCostUnits += l.quantity;
        row.missingCostRevenue += l.revenue;
      }
      rows.set(l.productId, row);
    }
  }

  const productRows: ProductRow[] = [...rows.values()]
    .map(({ docIds, ...r }) => ({
      ...r,
      salesCount: docIds.size,
      unitsSold: round(r.unitsSold),
      revenue: round(r.revenue),
      costedRevenue: round(r.costedRevenue),
      cost: round(r.cost),
      profit: round(r.profit),
      margin: r.costedRevenue > 0 ? round((r.profit / r.costedRevenue) * 100) : null,
      collectedRevenue: round(r.collectedRevenue),
      collectedProfit: round(r.collectedProfit),
      outstandingRevenue: round(r.revenue - r.collectedRevenue),
      outstandingProfit: round(r.profit - r.collectedProfit),
      missingCostUnits: round(r.missingCostUnits),
      missingCostRevenue: round(r.missingCostRevenue),
    }))
    .sort((a, b) => b.profit - a.profit || b.revenue - a.revenue);

  const sum = (key: keyof ProductRow) => round(productRows.reduce((s, r) => s + (Number(r[key]) || 0), 0));
  const costedRevenue = sum('costedRevenue');
  const profit = sum('profit');

  // Suggest a catalog match for unlinked lines whose text contains a product
  // name (catalog lines are written as "Name — description"). Longest name wins
  // so "Rice 50kg" beats "Rice".
  const catalogNames = activeCatalog
    .map((p) => ({ id: String(p._id), name: p.name, key: normaliseDescription(p.name) }))
    .filter((p) => p.key.length >= 2)
    .sort((a, b) => b.key.length - a.key.length);

  const unlinkedGroups = [...unlinked.entries()]
    .map(([key, g]) => {
      const match = catalogNames.find((p) => key.includes(p.key));
      return {
        ...g,
        units: round(g.units),
        revenue: round(g.revenue),
        suggestedProductId: match?.id ?? null,
        suggestedProductName: match?.name ?? null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const result: Record<string, unknown> = {
    method,
    range: { from: params.from || null, to: params.to || null },
    summary: {
      revenue: sum('revenue'),
      costedRevenue,
      cost: sum('cost'),
      profit,
      margin: costedRevenue > 0 ? round((profit / costedRevenue) * 100) : null,
      collectedRevenue: sum('collectedRevenue'),
      collectedProfit: sum('collectedProfit'),
      outstandingRevenue: sum('outstandingRevenue'),
      outstandingProfit: sum('outstandingProfit'),
      unitsSold: sum('unitsSold'),
      productsSold: productRows.length,
      missingCost: {
        products: productRows.filter((r) => r.missingCostUnits > 0).length,
        revenue: sum('missingCostRevenue'),
      },
      unlinked: {
        lines: unlinkedGroups.reduce((s, g) => s + g.lines, 0),
        revenue: round(unlinkedGroups.reduce((s, g) => s + g.revenue, 0)),
      },
      invoiceCount: docs.filter((d) => d.source === 'invoice').length,
      receiptCount: docs.filter((d) => d.source === 'receipt').length,
    },
    products: productRows,
    unlinked: unlinkedGroups.slice(0, 100),
  };

  // Drill-down: every sale of one product, newest first.
  if (params.productId) {
    result.sales = docs
      .flatMap((d) =>
        d.lines
          .filter((l) => l.productId === params.productId)
          .map((l) => ({
            source: d.source,
            id: d.id,
            number: d.number,
            date: d.date,
            customer: d.customer,
            status: d.status,
            paidPercent: round(d.paidRatio * 100),
            quantity: l.quantity,
            revenue: l.revenue,
            unitCost: l.unitCost,
            cost: l.cost,
            profit: costKnown(l) ? l.profit : null,
            collectedProfit: costKnown(l) ? l.collectedProfit : null,
          })),
      )
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 200);
  }

  return result;
};

// Attaches a catalog product to every past sale line with this exact
// description (case/whitespace-insensitive) that isn't linked to anything yet,
// on both invoices and receipts. Captures the product's current cost on those
// lines. Deliberately does NOT touch stock — those items left the shelf long
// ago, and the count has likely been corrected by hand since.
export const linkSalesToProduct = async (
  businessId: mongoose.Types.ObjectId,
  params: { description?: string; productId?: string },
) => {
  const description = String(params.description || '').trim();
  if (!description) throw new AppError('Description is required', 400);
  if (!params.productId || !mongoose.isValidObjectId(params.productId)) throw new AppError('Choose a product', 400);

  const product = await Product.findOne({ _id: params.productId, businessId }).select('+costPrice').lean();
  if (!product) throw new AppError('Product not found', 404);

  const words = description.split(/\s+/).map(escapeRegex).join('\\s+');
  const rx = new RegExp(`^\\s*${words}\\s*$`, 'i');
  const cost = typeof product.costPrice === 'number' ? product.costPrice : undefined;

  const [inv, rc] = await Promise.all([
    Invoice.updateMany(
      { businessId, lineItems: { $elemMatch: { description: rx, productId: null } } },
      {
        $set: {
          'lineItems.$[l].productId': product._id,
          ...(cost !== undefined ? { 'lineItems.$[l].unitCost': cost } : {}),
        },
      },
      { arrayFilters: [{ 'l.description': rx, 'l.productId': null }] },
    ),
    Receipt.updateMany(
      { businessId, items: { $elemMatch: { description: rx, productId: null } } },
      {
        $set: {
          'items.$[i].productId': product._id,
          ...(cost !== undefined ? { 'items.$[i].unitCost': cost } : {}),
        },
      },
      { arrayFilters: [{ 'i.description': rx, 'i.productId': null }] },
    ),
  ]);

  return { invoicesUpdated: inv.modifiedCount, receiptsUpdated: rc.modifiedCount, productName: product.name };
};
