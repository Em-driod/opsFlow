import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import User from '../models/User.js';

let io: SocketIOServer | null = null;

export const initSocketServer = (server: HTTPServer) => {
  io = new SocketIOServer(server, {
    cors: {
      origin: '*', // Adjust this in production
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
  });

  // Authentication Middleware for Sockets
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret') as JwtPayload;
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
    console.log(`🔌 Client connected: ${socket.id} (User: ${socket.data.user?.id})`);

    // Join a room based on their businessId so they only get their org's events
    const businessId = socket.data.user?.businessId;
    if (businessId) {
      socket.join(String(businessId));
      console.log(`🏠 Socket ${socket.id} joined room ${businessId}`);
    }

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  console.log('[Socket.io] Real-time server initialized.');
};

/**
 * Emit an event to a specific business room
 */
export const emitToBusiness = (businessId: string, eventName: string, payload: any) => {
  if (io) {
    io.to(businessId).emit(eventName, payload);
  } else {
    console.warn(`⚠️ Attempted to emit '${eventName}' but Socket.io is not initialized.`);
  }
};
