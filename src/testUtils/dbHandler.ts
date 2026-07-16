import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod: MongoMemoryServer | undefined;

export const connect = async (): Promise<void> => {
  mongod = await MongoMemoryServer.create({
    instance: {
      ip: '127.0.0.1',
      launchTimeout: 60000,
    },
  });
  await mongoose.connect(mongod.getUri());
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
