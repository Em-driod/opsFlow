import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` inside a MongoDB multi-document transaction, so related writes
 * (e.g. an invoice payment and its income Transaction) commit or roll back together.
 *
 * `withTransaction` retries `fn` on transient errors (write conflicts), so `fn`
 * must be safe to re-run: load documents *inside* it with `.session(session)`
 * rather than mutating documents fetched beforehand, and do side effects
 * (emails, sockets, notifications) only after this resolves.
 *
 * Requires a replica set — MongoDB Atlas always is one; tests use MongoMemoryReplSet.
 */
export const runInTransaction = async <T>(fn: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
};

export const isDuplicateKeyError = (e: unknown): boolean => (e as { code?: number })?.code === 11000;
