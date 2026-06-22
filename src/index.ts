// src/index.ts
import dotenv from 'dotenv';
dotenv.config(); // MUST be first — before anything else

import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import http from 'http';

import connectDB from './config/db.js';

import userRoutes from './routes/userRoutes.js';
import businessRoutes from './routes/businessRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import transactionRoutes from './routes/transactionRoutes.js';
import payrollRoutes from './routes/payrollRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import reportingRoutes from './routes/reportingRoutes.js';
import invoiceRoutes from './routes/invoiceRoutes.js';
import currencyRoutes from './routes/currencyRoutes.js';
import scannedTransactionRoutes from './routes/scannedTransactionRoutes.js';
import activityRoutes from './routes/activityRoutes.js';
import exportRoutes from './routes/exportRoutes.js';
import intelligenceRoutes from './routes/intelligenceRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import automationRoutes from './routes/automationRoutes.js';
import capitalAssetRoutes from './routes/capitalAssetRoutes.js';
import taxRoutes from './routes/taxRoutes.js';
import recurringInvoiceRoutes from './routes/recurringInvoiceRoutes.js';
import proposalRoutes from './routes/proposalRoutes.js';
import productRoutes from './routes/productRoutes.js';
import budgetRoutes from './routes/budgetRoutes.js';
import searchRoutes from './routes/searchRoutes.js';
import receiptRoutes from './routes/receiptRoutes.js';
import { initCronJobs } from './services/cronService.js';
import { initSocketServer } from './services/socketService.js';
import rateLimit from 'express-rate-limit';
import { sanitizeBody } from './middleware/sanitize.js';

/* ─────────────────────────────────────────────
   CORS — only allow known origins
   Add your production domain to ALLOWED_ORIGINS
   or set ALLOWED_ORIGINS=https://app.morniy.com in .env
───────────────────────────────────────────── */
const ALLOWED_ORIGINS: string[] = [
  'http://localhost:5173',   // Vite dev
  'http://localhost:4173',   // Vite preview
  'http://localhost:3000',
  'capacitor://localhost',   // Capacitor Android/iOS
  'https://localhost',
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : []),
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman in dev)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

const startServer = async () => {
  try {
    await connectDB();

    const app: Application = express();
    const server = http.createServer(app);

    initSocketServer(server);
    initCronJobs();

    /* ── Security headers ── */
    app.use(helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow images/assets from CDN
      contentSecurityPolicy: false, // front-end handles its own CSP via Vite
    }));

    /* ── CORS ── */
    app.use(cors(corsOptions));
    app.options('*', cors(corsOptions)); // pre-flight for all routes

    /* ── Request logging ── */
    app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

    /* ── Body parsing ── */
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ limit: '10mb', extended: true }));

    /* ── Input sanitisation ── */
    app.use(sanitizeBody);

    /* ── Rate limiters ── */
    const publicLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests, please try again later.' },
    });
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many login attempts, please try again later.' },
    });

    app.use('/api/invoices/public', publicLimiter);
    app.use('/api/proposals/public', publicLimiter);
    app.use('/api/payrolls/payslip', publicLimiter);
    app.use('/api/clients/portal', publicLimiter);
    app.use('/api/businesses/public', publicLimiter);
    app.use('/api/users/login', authLimiter);
    app.use('/api/users/register', authLimiter);

    /* ── Routes ── */
    app.use('/api/users', userRoutes);
    app.use('/api/businesses', businessRoutes);
    app.use('/api/clients', clientRoutes);
    app.use('/api/transactions', transactionRoutes);
    app.use('/api/payrolls', payrollRoutes);
    app.use('/api/dashboard', dashboardRoutes);
    app.use('/api/notifications', notificationRoutes);
    app.use('/api/reporting', reportingRoutes);
    app.use('/api/invoices', invoiceRoutes);
    app.use('/api/currency', currencyRoutes);
    app.use('/api/scanned-transactions', scannedTransactionRoutes);
    app.use('/api/activity', activityRoutes);
    app.use('/api/export', exportRoutes);
    app.use('/api/intelligence', intelligenceRoutes);
    app.use('/api/projects', projectRoutes);
    app.use('/api/automation', automationRoutes);
    app.use('/api/capital-assets', capitalAssetRoutes);
    app.use('/api/tax', taxRoutes);
    app.use('/api/recurring-invoices', recurringInvoiceRoutes);
    app.use('/api/proposals', proposalRoutes);
    app.use('/api/products', productRoutes);
    app.use('/api/budgets', budgetRoutes);
    app.use('/api/search', searchRoutes);
    app.use('/api/receipts', receiptRoutes);

    /* ── Utility endpoints ── */
    app.get('/', (_req: Request, res: Response) => {
      res.status(200).json({ name: 'Morniy API', status: 'running' });
    });
    app.get('/api/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    /* ── 404 handler ── */
    app.use((_req: Request, res: Response) => {
      res.status(404).json({ message: 'Route not found.' });
    });

    /* ── Global error handler ── */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status ?? err.statusCode ?? 500;
      const message = err.message || 'Internal server error.';

      if (process.env.NODE_ENV !== 'production') {
        console.error(`[ERROR] ${status} — ${message}`, err.stack);
      } else {
        // In production, only log 5xx to avoid leaking stack traces
        if (status >= 500) console.error(`[ERROR] ${status} — ${message}`);
      }

      res.status(status).json({ message });
    });

    const PORT = Number(process.env.PORT) || 5000;
    server.listen(PORT, () => {
      console.log(`🚀 Morniy API running on port ${PORT} [${process.env.NODE_ENV ?? 'development'}]`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
