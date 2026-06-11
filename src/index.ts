// src/index.ts
import dotenv from 'dotenv';
dotenv.config(); // MUST be first — before anything else

import express, { type Application, type Request, type Response } from 'express';
import cors from 'cors';
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

const startServer = async () => {
  try {
    // ✅ Connect to MongoDB FIRST
    await connectDB();

    const app: Application = express();
    const server = http.createServer(app);

    // ✅ Initialize Socket.io
    initSocketServer(server);

    // ✅ Initialize Automation Scheduler
    initCronJobs();

    // Middleware
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ limit: '10mb', extended: true }));
    app.use(sanitizeBody);

    // Rate limiters
    const publicLimiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests, please try again later.' },
    });
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
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

    // Routes
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

    // Root route
    app.get('/', (_req: Request, res: Response) => {
      res.status(200).send('OpsFlow API is running. Direct access is via /api endpoints.');
    });

    // Health check
    app.get('/api/health', (_req: Request, res: Response) => {
      res.status(200).json({
        status: 'OK',
        message: 'Server is running',
      });
    });

    const PORT = Number(process.env.PORT) || 5000;
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
