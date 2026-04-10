// src/services/webhookService.ts
// Fires outbound HTTP webhook events to registered URLs.
// Supports HMAC signature signing, retries, and event filtering.

import crypto from 'crypto';
import ExportConfig from '../models/ExportConfig.js';

export type WebhookEvent =
  | 'transaction.created'
  | 'transaction.updated'
  | 'client.created'
  | 'client.updated'
  | 'invoice.created'
  | 'invoice.updated'
  | 'payroll.created'
  | 'payroll.updated';

interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  businessId: string;
  data: any;
}

const MAX_RETRIES = 3;

function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliverWebhook(url: string, secret: string | undefined, payload: WebhookPayload, attempt = 1): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-OpsFlow-Event': payload.event,
    'X-OpsFlow-Timestamp': payload.timestamp,
  };

  if (secret) {
    headers['X-OpsFlow-Signature'] = `sha256=${signPayload(secret, body)}`;
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[Webhook] ✅ Delivered "${payload.event}" to ${url}`);
  } catch (err) {
    console.warn(`[Webhook] ❌ Attempt ${attempt} failed for ${url}:`, (err as Error).message);
    if (attempt < MAX_RETRIES) {
      const delay = 1000 * attempt * 2; // exponential: 2s, 4s, 6s
      setTimeout(() => deliverWebhook(url, secret, payload, attempt + 1), delay);
    }
  }
}

// Fire an event to all registered webhooks for a business that subscribe to it
export async function fire(event: WebhookEvent, businessId: string, data: any): Promise<void> {
  try {
    const config = await ExportConfig.findOne({ businessId });
    if (!config || !config.webhooks?.length) return;

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      businessId: String(businessId),
      data,
    };

    const matchingWebhooks = config.webhooks.filter(
      (wh: any) => wh.active && (wh.events.includes(event) || wh.events.includes('*')),
    );

    for (const wh of matchingWebhooks) {
      deliverWebhook(wh.url, wh.secret, payload); // fire-and-forget (async delivery)

      // Update lastTriggeredAt
      wh.lastTriggeredAt = new Date();
    }

    if (matchingWebhooks.length > 0) {
      await config.save();
    }
  } catch (err) {
    console.error('[Webhook] Error firing event:', err);
  }
}
