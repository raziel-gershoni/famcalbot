import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getUserByTelegramId } from '@/src/services/user-service';
import { MessagingPlatform } from '@/src/services/messaging';
import { getProgressText, formatProgressMessage } from '@/src/services/progress-message';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Map command to progress type
function getProgressType(command: string, args?: string): 'summary' | 'summaryTomorrow' | 'weather' | null {
  if (command === 'summary') {
    return args?.toLowerCase().trim() === 'tmrw' ? 'summaryTomorrow' : 'summary';
  }
  if (command === 'weather') {
    return 'weather';
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, command, args, secret, language } = body;

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

    // Send progress message IMMEDIATELY (before any DB queries)
    // This makes the response feel instant
    let progressMessageId: number | undefined;
    const progressType = getProgressType(command, args);

    if (progressType && language) {
      try {
        const { getMessagingService } = await import('@/src/services/telegram');
        const messagingService = getMessagingService();
        const progressText = getProgressText(progressType, language);
        progressMessageId = await messagingService.sendMessage(
          user_id,
          formatProgressMessage(progressText, 0)
        ) as number;
      } catch (err) {
        console.error('Failed to send initial progress:', err);
      }
    }

    // Now get user from database
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

    // Schedule command to run after response is sent (keeps function alive)
    // Using Next.js `after()` to ensure background work completes
    after(async () => {
      try {
        switch (command) {
          case 'testai':
            await handleTestAICommand(user_id, user_id, args);
            break;
          case 'summary':
            await handleSummaryCommand(
              user_id,
              user_id,
              MessagingPlatform.TELEGRAM,
              args,
              progressMessageId
            );
            break;
          case 'weather':
            await handleWeatherCommand(
              user_id,
              user_id,
              MessagingPlatform.TELEGRAM,
              args,
              progressMessageId
            );
            break;
        }
      } catch (err) {
        console.error(`${command} command error:`, err);
      }
    });

    if (command !== 'testai' && command !== 'summary' && command !== 'weather') {
      return NextResponse.json({
        success: false,
        error: `Unknown command: ${command}`
      }, { status: 400 });
    }

    // Return immediately after progress message is sent
    // Command continues executing via after()
    return NextResponse.json({
      success: true,
      message: 'Command started',
      progressMessageId,
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
