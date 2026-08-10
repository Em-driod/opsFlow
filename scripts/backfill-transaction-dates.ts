/**
 * One-off migration: backfill `date` on existing Transaction documents.
 *
 * Context: the Transaction schema previously had no `date` field, only the
 * auto-managed `createdAt` timestamp. Reports/tax/invoices now filter by
 * `date` instead of `createdAt` (createdAt reflects when a record was typed
 * in, not when the transaction actually happened). Documents created before
 * this change have no `date` value at all, so this script sets `date =
 * createdAt` for them — the best available approximation, since we have no
 * record of the date the user originally intended.
 *
 * Safe to run multiple times: only touches documents where `date` is unset.
 *
 * Usage:
 *   cd opsflow-backend
 *   npx tsx scripts/backfill-transaction-dates.ts          # dry run (reports count only)
 *   npx tsx scripts/backfill-transaction-dates.ts --apply   # actually writes
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Transaction from '../src/models/Transaction.js';

const apply = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in environment');

  await mongoose.connect(uri);

  const missingDateFilter = { date: { $exists: false } };
  const count = await Transaction.countDocuments(missingDateFilter);

  if (count === 0) {
    console.log('Nothing to backfill — every transaction already has a date.');
    await mongoose.disconnect();
    return;
  }

  console.log(`${count} transaction(s) missing a date.`);

  if (!apply) {
    console.log('Dry run only — re-run with --apply to write changes.');
    await mongoose.disconnect();
    return;
  }

  const result = await Transaction.updateMany(missingDateFilter, [{ $set: { date: '$createdAt' } }]);

  console.log(`Backfilled date on ${result.modifiedCount} transaction(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
