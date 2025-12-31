import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getUserByTelegramId } from '@/src/services/user-service';
import { MessagingPlatform } from '@/src/services/messaging';
import { getProgressText, formatProgressMessage } from '@/src/services/progress-message';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { checkRateLimit, commandRateLimiter, getRateLimitHeaders } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Map command to progress type
function getProgressType(command: string, args?: string): 'summary' | 'summaryTomorrow' | 'weather' | 'lookahead' | null {
  if (command === 'summary') {
    return args?.toLowerCase().trim() === 'tmrw' ? 'summaryTomorrow' : 'summary';
  }
  if (command === 'weather') {
    return 'weather';
  }
  if (command === 'lookahead') {
    return 'lookahead';
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, command, args, secret, language, initData } = body;

    // Validate required parameters
    if (!user_id || !command) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: user_id, command'
      }, { status: 400 });
    }

    // Authentication: Either server secret OR valid Telegram initData
    const hasServerSecret = secret && secret === process.env.CRON_SECRET;
    const hasTelegramAuth = initData && verifyUserAccess(initData, user_id);

    if (!hasServerSecret && !hasTelegramAuth) {
      console.warn(`[execute-command] Unauthorized access attempt for user ${user_id}`);
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Rate limiting (skip for server-side cron calls)
    if (!hasServerSecret) {
      const rateLimitResult = await checkRateLimit(commandRateLimiter, user_id);
      if (!rateLimitResult.success) {
        console.warn(`[execute-command] Rate limit exceeded for user ${user_id}`);
        return NextResponse.json(
          { success: false, error: 'Too many requests. Please wait a minute.' },
          { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
        );
      }
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
      handleWeatherCommand,
      handleLookaheadCommand
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
          case 'lookahead':
            await handleLookaheadCommand(
              user_id,
              user_id,
              MessagingPlatform.TELEGRAM,
              progressMessageId
            );
            break;
        }
      } catch (err) {
        captureError(err, 'execute-command', {
          command,
          user_id,
          args,
          api_route: '/api/execute-command'
        });

        // Send error message to user
        try {
          const { getMessagingService } = await import('@/src/services/telegram');
          const messagingService = getMessagingService();
          const errorMessage = '❌ Sorry, something went wrong processing your request. Please try again.';

          if (progressMessageId) {
            // Update progress message with error
            await messagingService.updateMessage(user_id, progressMessageId, errorMessage);
          } else {
            // Send new error message
            await messagingService.sendMessage(user_id, errorMessage);
          }
        } catch (notifyErr) {
          captureError(notifyErr, 'execute-command-notify', { user_id });
        }
      }
    });

    if (command !== 'testai' && command !== 'summary' && command !== 'weather' && command !== 'lookahead') {
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
    captureError(error, 'execute-command', { api_route: '/api/execute-command' });
    return NextResponse.json({
      success: false,
      error: 'Command execution failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
