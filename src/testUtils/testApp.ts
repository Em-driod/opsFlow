import express, { type Request, type Response, type NextFunction } from 'express';
import userRoutes from '../routes/userRoutes.js';
import businessRoutes from '../routes/businessRoutes.js';
import invoiceRoutes from '../routes/invoiceRoutes.js';
import payrollRoutes from '../routes/payrollRoutes.js';
import taxRoutes from '../routes/taxRoutes.js';
import transactionRoutes from '../routes/transactionRoutes.js';
import reportingRoutes from '../routes/reportingRoutes.js';
import { protect, admin } from '../middleware/auth.js';
import { sanitizeBody } from '../middleware/sanitize.js';
import { jsonParser } from '../middleware/bodyParsers.js';
import receiptRoutes from '../routes/receiptRoutes.js';
import clientRoutes from '../routes/clientRoutes.js';
import productRoutes from '../routes/productRoutes.js';
import orderRoutes from '../routes/orderRoutes.js';
import paymentRoutes from '../routes/paymentRoutes.js';

export const createTestApp = () => {
  const app = express();
  app.use(jsonParser); // same parser as production (keeps raw bytes for webhooks)
  app.use(sanitizeBody);
  app.use('/api/users', userRoutes);
  app.use('/api/businesses', businessRoutes);
  app.use('/api/invoices', invoiceRoutes);
  app.use('/api/payrolls', payrollRoutes);
  app.use('/api/tax', taxRoutes);
  app.use('/api/transactions', transactionRoutes);
  app.use('/api/reporting', reportingRoutes);
  app.use('/api/receipts', receiptRoutes);
  app.use('/api/clients', clientRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/payments', paymentRoutes);

  // Minimal routes for exercising the auth middleware directly.
  app.get('/api/test/protected', protect, (req: Request, res: Response) => {
    res.json({ ok: true, userId: req.user?._id });
  });
  app.get('/api/test/admin-only', protect, admin, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Mirrors the production global error handler in src/index.ts.
   
  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ message: err.message || 'Internal server error.' });
  });

  return app;
};
