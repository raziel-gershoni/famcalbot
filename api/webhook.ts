import type { VercelRequest, VercelResponse } from '@vercel/node';
import { detectPlatform, MessagingPlatform } from '../src/services/messaging';
import { handleTelegramWebhook, handleWhatsAppWebhook } from '../src/services/webhook-handlers';

/**
 * Multi-Platform Webhook Handler
 * Receives updates from Telegram and WhatsApp and routes to appropriate handlers
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Handle WhatsApp webhook verification (GET request)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // WhatsApp webhook verification
    if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      console.log('[WhatsApp] Webhook verified');
      res.status(200).send(challenge);
      return;
    } else {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }

  // Only allow POST requests for webhook updates
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Load environment variables for serverless
    await import('dotenv/config');

    // Detect platform from webhook structure
    const platform = detectPlatform(req);
    console.log(`[Webhook] Detected platform: ${platform}, Body object field: ${req.body?.object}`);

    // Route to platform-specific handler
    if (platform === MessagingPlatform.WHATSAPP) {
      console.log('[Webhook] Routing to WhatsApp handler');
      await handleWhatsAppWebhook(req, res);
    } else {
      console.log('[Webhook] Routing to Telegram handler');
      await handleTelegramWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in webhook handler:', error);
    // Notify admin of webhook errors
    try {
      const { notifyAdminError } = await import('../src/utils/error-notifier');
      await notifyAdminError('Webhook Handler', error, `Update: ${JSON.stringify(req.body)}`);
    } catch (notifyError) {
      console.error('Failed to notify admin:', notifyError);
    }
    res.status(200).json({ ok: true }); // Always return 200 to prevent retries
  }
}
