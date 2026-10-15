import { NextRequest, NextResponse } from 'next/server';
import { detectPlatform, MessagingPlatform } from '@/src/services/messaging';
import { captureError } from '@/src/lib/error-capture';
import { checkWhatsAppSignature } from '@/src/lib/whatsapp-signature';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  // WhatsApp webhook verification
  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    console.log('[WhatsApp] Webhook verified');
    return new NextResponse(challenge, { status: 200 });
  } else {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
}

export async function POST(request: NextRequest) {
  try {
    // The raw text, not request.json(): Meta's signature covers the exact bytes
    const rawBody = await request.text();
    const body = JSON.parse(rawBody);

    // Detect platform from webhook structure
    const platform = detectPlatform({ body } as { body: Record<string, unknown> });

    if (platform === MessagingPlatform.WHATSAPP) {
      // Verify Meta's signature (X-Hub-Signature-256) before a handler acts on the body
      const signature = checkWhatsAppSignature(rawBody, request.headers.get('X-Hub-Signature-256'));
      if (signature === 'rejected') {
        console.warn('[Webhook] Invalid or missing WhatsApp signature');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      if (signature === 'unconfigured') {
        console.error('[Webhook] WHATSAPP_APP_SECRET not configured');
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
      }
    } else {
      // Verify Telegram webhook secret token (mandatory)
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.error('[Webhook] TELEGRAM_WEBHOOK_SECRET not configured');
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
      }
      const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (providedSecret !== webhookSecret) {
        console.warn('[Webhook] Invalid or missing Telegram secret token');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    console.log(`[Webhook] Detected platform: ${platform}, Body object field: ${body?.object}`);

    // Create minimal request/response objects for webhook handlers
    const mockReq = { body };
    const mockRes = {
      status: () => ({ json: () => {} })
    };

    // Route to platform-specific handler
    if (platform === MessagingPlatform.WHATSAPP) {
      console.log('[Webhook] Routing to WhatsApp handler');
      const { handleWhatsAppWebhook } = await import('@/src/services/webhook-handlers');
      await handleWhatsAppWebhook(mockReq, mockRes);
    } else {
      console.log('[Webhook] Routing to Telegram handler');
      const { handleTelegramWebhook } = await import('@/src/services/webhook-handlers');
      await handleTelegramWebhook(mockReq, mockRes);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    captureError(error, 'webhook', { api_route: '/api/webhook' });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
