import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

// A single-node replica set (not a standalone server) so multi-document
// transactions work in tests exactly as they do on MongoDB Atlas.
let mongod: MongoMemoryReplSet | undefined;

export const connect = async (): Promise<void> => {
  mongod = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
    instanceOpts: [{ launchTimeout: 60000 }],
  });
  await mongoose.connect(mongod.getUri());
  // Transactions can't create collections/indexes on the fly — build them up front.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
};

export const closeDatabase = async (): Promise<void> => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  if (mongod) await mongod.stop();
};

export const clearDatabase = async (): Promise<void> => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]?.deleteMany({});
  }
};
