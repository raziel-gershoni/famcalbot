import { NextRequest, NextResponse } from 'next/server';
import { detectPlatform, MessagingPlatform } from '@/src/services/messaging';
import { captureError } from '@/src/lib/error-capture';

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
    const body = await request.json();

    // Detect platform from webhook structure
    const platform = detectPlatform({ body } as any);

    // Verify Telegram webhook secret token (if configured)
    if (platform !== MessagingPlatform.WHATSAPP) {
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (webhookSecret) {
        const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (providedSecret !== webhookSecret) {
          console.warn('[Webhook] Invalid or missing Telegram secret token');
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
      }
    }
    console.log(`[Webhook] Detected platform: ${platform}, Body object field: ${body?.object}`);

    // Create mock VercelRequest/Response objects for compatibility
    const mockReq = { body } as any;
    const mockRes = {
      status: () => ({ json: () => {} })
    } as any;

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
