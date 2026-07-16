import request from 'supertest';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';

const app = createTestApp();

beforeAll(async () => {
  await connect();
}, 60000);

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('POST /api/users/register', () => {
  it('registers a new user + business and returns a token', async () => {
    const res = await request(app).post('/api/users/register').send({
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'password123',
      businessName: 'Acme Ltd',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.email).toBe('jane@example.com');
    expect(res.body.role).toBe('admin');
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/api/users/register').send({
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'password123',
      businessName: 'Acme Ltd',
    });
    const res = await request(app).post('/api/users/register').send({
      name: 'Jane Doe 2',
      email: 'jane@example.com',
      password: 'password456',
      businessName: 'Acme Ltd 2',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/users/login', () => {
  it('logs in with correct credentials', async () => {
    await request(app).post('/api/users/register').send({
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'password123',
      businessName: 'Acme Ltd',
    });

    const res = await request(app).post('/api/users/login').send({
      email: 'jane@example.com',
      password: 'password123',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('rejects an incorrect password', async () => {
    await request(app).post('/api/users/register').send({
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'password123',
      businessName: 'Acme Ltd',
    });

    const res = await request(app).post('/api/users/login').send({
      email: 'jane@example.com',
      password: 'wrong-password',
    });
    expect(res.status).toBe(401);
  });
});
