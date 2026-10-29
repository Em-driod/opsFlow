import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import User from '../models/User.js';
import { isAllowedOrigin } from '../config/origins.js';
import { logger } from '../utils/logger.js';

let io: SocketIOServer | null = null;

export const initSocketServer = (server: HTTPServer) => {
  io = new SocketIOServer(server, {
    cors: {
      // Same allowlist as the HTTP API (config/origins.ts).
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) return callback(null, true);
        callback(new Error(`Socket CORS: origin ${origin} not allowed`));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Authentication Middleware for Sockets
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) return next(new Error('Authentication error'));

    try {
      const decoded = jwt.verify(token, secret) as JwtPayload;
      // The JWT only carries { id } — look up businessId so the socket can join its room.
      const user = await User.findById(decoded.id).select('businessId');
      if (!user) {
        return next(new Error('Authentication error'));
      }
      socket.data.user = { id: String(user._id), businessId: String(user.businessId) };
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`🔌 Client connected: ${socket.id} (User: ${socket.data.user?.id})`);

    // Join a room based on their businessId so they only get their org's events
    const businessId = socket.data.user?.businessId;
    if (businessId) {
      socket.join(String(businessId));
      logger.info(`🏠 Socket ${socket.id} joined room ${businessId}`);
    }

    socket.on('disconnect', () => {
      logger.info(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  logger.info('[Socket.io] Real-time server initialized.');
};

/**
 * Emit an event to a specific business room
 */
export const emitToBusiness = (businessId: string, eventName: string, payload: unknown) => {
  if (io) {
    io.to(businessId).emit(eventName, payload);
  } else {
    logger.warn(`⚠️ Attempted to emit '${eventName}' but Socket.io is not initialized.`);
  }
};
