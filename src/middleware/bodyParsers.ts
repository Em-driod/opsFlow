import express from 'express';
import type { IncomingMessage } from 'http';

declare module 'express-serve-static-core' {
  interface Request {
    // Exact bytes of the request body, captured only for webhook routes whose
    // signatures are computed over the raw payload.
    rawBody?: Buffer;
  }
}

// Paths whose senders sign the raw body. The signature must be checked against
// these exact bytes — re-serialising the parsed (and sanitised) JSON can change
// them and make valid deliveries fail verification.
const RAW_BODY_PATHS = ['/api/invoices/webhooks/', '/api/payments/webhooks/'];

const captureRawBody = (req: IncomingMessage, _res: unknown, buf: Buffer) => {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  if (RAW_BODY_PATHS.some((p) => url.startsWith(p))) {
    (req as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  }
};

export const jsonParser = express.json({ limit: '10mb', verify: captureRawBody });
export const urlencodedParser = express.urlencoded({ limit: '10mb', extended: true });
