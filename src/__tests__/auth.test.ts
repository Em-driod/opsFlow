import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';

const app = createTestApp();

const createUser = async (role: 'admin' | 'staff' = 'admin') => {
  const business = await Business.create({ name: 'Test Biz' });
  const user = await User.create({
    name: 'Test User',
    email: `${role}-${Date.now()}@example.com`,
    password: 'hashed-not-used-here',
    role,
    authProvider: 'local',
    businessId: business._id,
  });
  return user;
};

const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

beforeAll(async () => {
  await connect();
}, 60000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('protect middleware', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(app).get('/api/test/protected');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed/garbage token', async () => {
    const res = await request(app)
      .get('/api/test/protected')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const user = await createUser();
    const expiredToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET!, { expiresIn: '-1s' });
    const res = await request(app)
      .get('/api/test/protected')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token for a user that no longer exists', async () => {
    const user = await createUser();
    const token = signToken(user._id);
    await User.deleteOne({ _id: user._id });
    const res = await request(app)
      .get('/api/test/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('allows a request with a valid token', async () => {
    const user = await createUser();
    const token = signToken(user._id);
    const res = await request(app)
      .get('/api/test/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(String(user._id));
  });
});

describe('admin middleware', () => {
  it('blocks a staff (non-admin) user', async () => {
    const staff = await createUser('staff');
    const token = signToken(staff._id);
    const res = await request(app)
      .get('/api/test/admin-only')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('allows an admin user', async () => {
    const adminUser = await createUser('admin');
    const token = signToken(adminUser._id);
    const res = await request(app)
      .get('/api/test/admin-only')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
