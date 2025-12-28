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

    // Set menu button for quick dashboard access
    const dashboardUrl = buildUrl('/en/dashboard');
    await bot.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: 'Dashboard',
        web_app: { url: dashboardUrl }
      }
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
