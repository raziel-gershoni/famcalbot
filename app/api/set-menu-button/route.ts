import { NextRequest, NextResponse } from 'next/server';
import { getBot } from '@/src/services/telegram';
import { captureError } from '@/src/lib/error-capture';
import { buildUrl } from '@/src/config/urls';
import { matchesSecret } from '@/src/lib/secret-compare';

export const dynamic = 'force-dynamic';

/**
 * Manual endpoint to set Telegram menu button
 * Call this endpoint to configure the menu button
 * GET /api/set-menu-button, with `Authorization: Bearer <CRON_SECRET>` (the operator's secret, as for the cron
 * routes): it resets the bot's default menu button for everyone, so it is not open. No query-string secret (URLs end
 * up in logs), and an unset CRON_SECRET opens nothing (matchesSecret).
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization');
  const given = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  if (!matchesSecret(given, process.env.CRON_SECRET)) {
    console.warn('[set-menu-button] Refused a request without a valid Authorization: Bearer secret');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const bot = getBot();

    // Set the GLOBAL default menu button (no chat_id)
    const dashboardUrl = buildUrl('/en/dashboard');
    await bot.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Dashboard', web_app: { url: dashboardUrl } },
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
    console.error('[set-menu-button] Setting the menu button failed:', error);
    captureError(error, 'set-menu-button', { api_route: '/api/set-menu-button' });

    // What went wrong is in the log and in Sentry, not in the answer
    return NextResponse.json({ success: false, error: 'Failed to set the menu button' }, { status: 500 });
  }
}
