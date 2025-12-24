import { NextResponse } from 'next/server';
import { getBot } from '@/src/services/telegram';

/**
 * Manual endpoint to set Telegram menu button
 * Call this endpoint to configure the menu button
 * GET /api/set-menu-button
 */
export async function GET() {
  try {
    const bot = getBot();

    // Set menu button for quick dashboard access
    await bot.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: '🚀 Dashboard',
        web_app: { url: 'https://famcalbot.vercel.app/dashboard' }
      }
    });

    return NextResponse.json({
      success: true,
      message: '✅ Menu button configured successfully!',
      menuButton: {
        type: 'web_app',
        text: '🚀 Dashboard',
        url: 'https://famcalbot.vercel.app/dashboard'
      }
    });
  } catch (error) {
    console.error('❌ Failed to set menu button:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: error
    }, { status: 500 });
  }
}
