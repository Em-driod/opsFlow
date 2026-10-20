// Single CORS allowlist shared by the HTTP API and the Socket.IO server, so the
// two can never drift apart (the socket server used to accept any origin).
// Add production domains via ALLOWED_ORIGINS=https://app.example.com,... in .env
const DEFAULT_ORIGINS = [
  'http://localhost:5173', // Vite dev
  'http://localhost:4173', // Vite preview
  'http://localhost:3000',
  'capacitor://localhost', // Capacitor Android/iOS
  'https://localhost',
];

// Read lazily: ES module imports are evaluated before index.ts runs dotenv.config(),
// so reading process.env at module load would miss values from .env.
export const getAllowedOrigins = (): string[] => [
  ...DEFAULT_ORIGINS,
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : []),
];

export const isAllowedOrigin = (origin: string | undefined): boolean =>
  // Requests with no Origin header (mobile apps, server-to-server, curl) are allowed;
  // CORS is a browser protection, and these callers still need a valid JWT.
  !origin || getAllowedOrigins().includes(origin);
