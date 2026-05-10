import { NextResponse } from 'next/server';
import { getBot } from '@/src/services/telegram';
import { captureError } from '@/src/lib/error-capture';
import { buildUrl } from '@/src/config/urls';

export const dynamic = 'force-dynamic';

/**
 * Manual endpoint to set Telegram menu button
 * Call this endpoint to configure the menu button
 * GET /api/set-menu-button
 */
export async function GET() {
  try {
    const bot = getBot();

    // Set the GLOBAL default menu button. node-telegram-bot-api v0.66 does
    // not auto-JSON-stringify the `menu_button` field (only reply_markup /
    // entities / reply_parameters get the auto-stringify treatment). Passing
    // an object would form-encode it as bracket notation, which the Bot API
    // rejects with 400. Pre-stringify here so the wire format is the
    // "JSON-serialized object" the API expects.
    const dashboardUrl = buildUrl('/en/dashboard');
    const menuButtonJson = JSON.stringify({
      type: 'web_app',
      text: 'Dashboard',
      web_app: { url: dashboardUrl }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bot as any).setChatMenuButton({
      menu_button: menuButtonJson
    });

    return NextResponse.json({
      success: true,
      message: '✅ Menu button configured successfully!',
      menuButton: {
        type: 'web_app',
        text: 'Dashboard',
        url: dashboardUrl
      }
    });
  } catch (error) {
    captureError(error, 'set-menu-button', { api_route: '/api/set-menu-button' });

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: error
    }, { status: 500 });
  }
}
