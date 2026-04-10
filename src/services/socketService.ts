import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';

let io: SocketIOServer | null = null;

export const initSocketServer = (server: HTTPServer) => {
  io = new SocketIOServer(server, {
    cors: {
      origin: '*', // Adjust this in production
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
  });

  // Authentication Middleware for Sockets
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret') as any;
      socket.data.user = decoded; // Store user data in socket
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
