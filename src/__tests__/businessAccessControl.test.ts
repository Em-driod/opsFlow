import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import '../models/Client.js'; // registers the Client schema so Business.populate('clients') works

const app = createTestApp();

const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const makeBusinessWithAdmin = async (label: string) => {
  const business = await Business.create({ name: `${label} Biz` });
  const admin = await User.create({
    name: `${label} Admin`,
    email: `${label}-admin-${Date.now()}@example.com`,
    password: 'irrelevant-hash',
    role: 'admin',
    authProvider: 'local',
    businessId: business._id,
  });
  return { business, admin };
};

beforeAll(async () => {
  await connect();
}, 60000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('cross-business access control on /api/businesses (regression for IDOR fix)', () => {
  it('blocks GET of a different business', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .get(`/api/businesses/${b.business._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('blocks PUT of a different business', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .put(`/api/businesses/${b.business._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked Name' });

    expect(res.status).toBe(404);
    const untouched = await Business.findById(b.business._id);
    expect(untouched?.name).toBe(b.business.name);
  });

  it('blocks DELETE of a different business', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .delete(`/api/businesses/${b.business._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    const stillThere = await Business.findById(b.business._id);
    expect(stillThere).not.toBeNull();
  });

  it('blocks adding a user to a different business', async () => {
    const a = await makeBusinessWithAdmin('A');
    const b = await makeBusinessWithAdmin('B');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .post(`/api/businesses/${b.business._id}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: String(a.admin._id) });

    expect(res.status).toBe(404);
  });

  it('allows an admin to GET/PUT their own business', async () => {
    const a = await makeBusinessWithAdmin('A');
    const token = signToken(a.admin._id);

    const getRes = await request(app)
      .get(`/api/businesses/${a.business._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);

    const putRes = await request(app)
      .put(`/api/businesses/${a.business._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed Biz' });
    expect(putRes.status).toBe(200);
    expect(putRes.body.name).toBe('Renamed Biz');
  });
});
