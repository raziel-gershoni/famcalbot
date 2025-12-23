import { NextRequest, NextResponse } from 'next/server';
import { detectPlatform, MessagingPlatform } from '@/src/services/messaging';

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
    console.error('[Webhook] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
