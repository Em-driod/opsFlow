import mongoose, { type ClientSession } from 'mongoose';

interface CostedLine {
  productId?: mongoose.Types.ObjectId | null | undefined;
  unitCost?: number | null | undefined;
}

// Copies each catalog product's current cost price onto the sale lines that
// reference it. Runs once, when the invoice/receipt is first saved, so later
// changes to a product's cost don't rewrite the profit of sales already made.
// The server is the source of truth here — any unitCost the client sent is
// replaced. Lines whose product has no cost set are left without one, and the
// profit report falls back to the product's cost at report time instead.
export const snapshotUnitCosts = async (
  businessId: mongoose.Types.ObjectId,
  lines: CostedLine[],
  session?: ClientSession | null,
) => {
  for (const line of lines) line.unitCost = undefined;

  const ids = [...new Set(lines.filter((l) => l.productId).map((l) => String(l.productId)))];
  if (ids.length === 0) return;

  // Resolved lazily so the Invoice/Receipt models don't need to import Product.
  const products = await mongoose
    .model('Product')
    .find({ _id: { $in: ids }, businessId })
    .select('+costPrice')
    .session(session ?? null)
    .lean<{ _id: mongoose.Types.ObjectId; costPrice?: number | null }[]>();
  const costById = new Map(products.map((p) => [String(p._id), p.costPrice]));

  for (const line of lines) {
    if (!line.productId) continue;
    const cost = costById.get(String(line.productId));
    if (typeof cost === 'number' && cost >= 0) line.unitCost = cost;
  }
};
