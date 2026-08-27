import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';

const app = createTestApp();

const signToken = (id: unknown) => jwt.sign({ id }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const makeBusinessWithUsers = async (label: string) => {
  const business = await Business.create({ name: `${label} Biz` });
  const admin = await User.create({
    name: `${label} Admin`,
    email: `${label}-admin-${Date.now()}@example.com`,
    password: 'irrelevant-hash',
    role: 'admin',
    authProvider: 'local',
    businessId: business._id,
  });
  const staff = await User.create({
    name: `${label} Staff`,
    email: `${label}-staff-${Date.now()}@example.com`,
    password: 'irrelevant-hash',
    role: 'staff',
    authProvider: 'local',
    businessId: business._id,
  });
  return { business, admin, staff };
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

describe('cross-business access control (regression for IDOR fix)', () => {
  it('blocks GET of a user belonging to a different business', async () => {
    const a = await makeBusinessWithUsers('A');
    const b = await makeBusinessWithUsers('B');
    const token = signToken(a.staff._id);

    const res = await request(app)
      .get(`/api/users/${b.staff._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('blocks PUT of a user belonging to a different business', async () => {
    const a = await makeBusinessWithUsers('A');
    const b = await makeBusinessWithUsers('B');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .put(`/api/users/${b.staff._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked Name' });

    expect(res.status).toBe(404);

    const untouched = await User.findById(b.staff._id);
    expect(untouched?.name).toBe(b.staff.name);
  });

  it('blocks a staff user from updating another user in the same business', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.staff._id);

    const res = await request(app)
      .put(`/api/users/${a.admin._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked Name' });

    expect(res.status).toBe(403);
  });

  it('blocks a staff user from self-promoting to admin', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.staff._id);

    const res = await request(app)
      .put(`/api/users/${a.staff._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    const updated = await User.findById(a.staff._id);
    expect(updated?.role).toBe('staff');
  });

  it('allows an admin to change a staff role within the same business', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .put(`/api/users/${a.staff._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    const updated = await User.findById(a.staff._id);
    expect(updated?.role).toBe('admin');
  });

  it('blocks an admin from deleting a user in a different business', async () => {
    const a = await makeBusinessWithUsers('A');
    const b = await makeBusinessWithUsers('B');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .delete(`/api/users/${b.staff._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    const stillThere = await User.findById(b.staff._id);
    expect(stillThere).not.toBeNull();
  });
});

describe('team management guardrails', () => {
  it('blocks an admin from deleting their own account', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .delete(`/api/users/${a.admin._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(await User.findById(a.admin._id)).not.toBeNull();
  });

  it('rejects a staff password shorter than 8 characters', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .post('/api/users/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'New Hire',
        email: `hire-${Date.now()}@example.com`,
        password: 'short',
        businessId: String(a.business._id),
      });

    expect(res.status).toBe(400);
  });

  it('links a newly created staff user into Business.users', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .post('/api/users/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'New Hire',
        email: `hire-${Date.now()}@example.com`,
        password: 'longenough1',
        businessId: String(a.business._id),
      });

    expect(res.status).toBe(201);
    const biz = await Business.findById(a.business._id);
    expect(biz?.users.map(String)).toContain(String(res.body._id));
  });

  it('rejects a duplicate staff email regardless of case', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .post('/api/users/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Clash',
        email: a.staff.email.toUpperCase(),
        password: 'longenough1',
        businessId: String(a.business._id),
      });

    expect(res.status).toBe(400);
  });
});

describe('role enforcement across modules', () => {
  it('blocks a staff user from deleting a transaction', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.staff._id);

    const res = await request(app)
      .delete(`/api/transactions/${a.business._id}`) // id shape irrelevant — gate runs before the handler
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('allows an admin past the same gate', async () => {
    const a = await makeBusinessWithUsers('A');
    const token = signToken(a.admin._id);

    const res = await request(app)
      .delete(`/api/transactions/${a.business._id}`)
      .set('Authorization', `Bearer ${token}`);

    // Not 403 — the admin clears the role gate (handler then 404s on the bogus id).
    expect(res.status).not.toBe(403);
  });
});
