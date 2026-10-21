import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../testUtils/testApp.js';
import { connect, closeDatabase, clearDatabase } from '../testUtils/dbHandler.js';
import User from '../models/User.js';
import Business from '../models/Business.js';
import Product from '../models/Product.js';

const app = createTestApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const makeShop = async () => {
  const business = await Business.create({ name: 'Shop', currency: 'NGN', slug: 'shop', profile: { isPublic: true } });
  const admin = await User.create({
    name: 'Admin',
    email: `admin-${Date.now()}-${Math.random()}@example.com`,
    password: 'irrelevant-hash',
    role: 'admin',
    authProvider: 'local',
    businessId: business._id,
  });
  return { business, token: jwt.sign({ id: admin._id }, process.env.JWT_SECRET!, { expiresIn: '1h' }) };
};

const addProduct = (token: string, body: Record<string, unknown>) =>
  request(app).post('/api/products').set(auth(token)).send({ price: 1000, ...body });

beforeAll(async () => {
  await connect();
}, 60000);
afterEach(async () => {
  await clearDatabase();
});
afterAll(async () => {
  await closeDatabase();
});

describe('catalog categories', () => {
  it('stores a tidied category and sub-category', async () => {
    const { token } = await makeShop();
    const res = await addProduct(token, { name: 'Coke', category: '  Drinks ', subcategory: 'Soft   drinks' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ category: 'Drinks', subcategory: 'Soft drinks' });
  });

  it('drops a sub-category when the category is cleared', async () => {
    const { token } = await makeShop();
    const created = await addProduct(token, { name: 'Coke', category: 'Drinks', subcategory: 'Soft drinks' });
    const res = await request(app).put(`/api/products/${created.body._id}`).set(auth(token)).send({ category: '' });
    expect(res.body.category).toBe('');
    expect(res.body.subcategory).toBe('');
  });

  it('renames a category or a sub-category on every product at once', async () => {
    const { token } = await makeShop();
    await addProduct(token, { name: 'Coke', category: 'Drinks', subcategory: 'Soft' });
    await addProduct(token, { name: 'Fanta', category: 'drinks', subcategory: 'Soft' });
    await addProduct(token, { name: 'Water', category: 'Drinks', subcategory: 'Water' });

    let res = await request(app).post('/api/products/categories/rename').set(auth(token)).send({ category: 'Drinks', newName: 'Beverages' });
    expect(res.body.updated).toBe(3);

    res = await request(app)
      .post('/api/products/categories/rename')
      .set(auth(token))
      .send({ category: 'Beverages', subcategory: 'soft', newName: 'Soft drinks' });
    expect(res.body.updated).toBe(2);
    expect(await Product.countDocuments({ category: 'Beverages', subcategory: 'Soft drinks' })).toBe(2);
  });

  it('shows category and sub-category on the public page', async () => {
    const { business, token } = await makeShop();
    await addProduct(token, { name: 'Coke', category: 'Drinks', subcategory: 'Soft drinks' });
    const res = await request(app).get(`/api/businesses/public/${business.slug}`);
    expect(res.body.profile.services[0]).toMatchObject({ name: 'Coke', category: 'Drinks', subcategory: 'Soft drinks' });
  });
});
