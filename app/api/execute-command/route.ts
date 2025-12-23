import { NextRequest, NextResponse } from 'next/server';
import { getUserByTelegramId } from '@/src/services/user-service';
import { MessagingPlatform } from '@/src/services/messaging';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, command, args, secret } = body;

    // Validate required parameters
    if (!user_id || !command) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: user_id, command'
      }, { status: 400 });
    }

    // Validate secret if provided (for server-side calls like cron)
    if (secret && secret !== process.env.CRON_SECRET) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get user from database
    const user = await getUserByTelegramId(user_id);
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // Check admin access for testai command
    if (command === 'testai' && !user.isAdmin) {
      return NextResponse.json({
        success: false,
        error: 'Admin access required for testai command'
      }, { status: 403 });
    }

    // Dynamically import to avoid build-time initialization
    const {
      handleTestAICommand,
      handleSummaryCommand,
      handleWeatherCommand
    } = await import('@/src/services/telegram');

    // Execute command (chatId = userId for Telegram)
    switch (command) {
      case 'testai':
        await handleTestAICommand(user_id, user_id, args);
        break;
      case 'summary':
        await handleSummaryCommand(
          user_id,
          user_id,
          MessagingPlatform.TELEGRAM,
          args
        );
        break;
      case 'weather':
        await handleWeatherCommand(
          user_id,
          user_id,
          MessagingPlatform.TELEGRAM,
          args
        );
        break;
      default:
        return NextResponse.json({
          success: false,
          error: `Unknown command: ${command}`
        }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Command executed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Command execution error:', error);
    return NextResponse.json({
      success: false,
      error: 'Command execution failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
