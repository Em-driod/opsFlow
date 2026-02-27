// src/index.ts
import dotenv from 'dotenv';
dotenv.config(); // MUST be first — before anything else

import express, { type Application, type Request, type Response } from 'express';
import cors from 'cors';

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

const startServer = async () => {
  try {
    // ✅ Connect to MongoDB FIRST
    await connectDB();

    const app: Application = express();

    // Middleware
    app.use(cors());
    app.use(express.json());

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
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
