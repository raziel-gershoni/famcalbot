import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getUserByTelegramId, getUserById } from '@/src/services/user-service';
import { MessagingPlatform, getMessagingService as getPlatformService } from '@/src/services/messaging';
import { verifyUserAuth, type AuthVia } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { resolveCommandTarget } from '@/src/lib/command-target';
import { commandRateLimiter } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';
import { matchesSecret } from '@/src/lib/secret-compare';
import { trackActivityAsync } from '@/src/services/analytics-service';
import type { UserConfig } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, command, args, secret } = body;
    // The X-Telegram-Init-Data header, else a string initData in the body
    const initData = requestInitData(request, body);

    // Validate required parameters
    if (!user_id || !command) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: user_id, command'
      }, { status: 400 });
    }

    // Authentication: server secret (operator path) OR Telegram initData OR session cookie
    const hasServerSecret = matchesSecret(secret, process.env.CRON_SECRET);
    let user: UserConfig | null;
    let via: AuthVia | 'server';

    if (hasServerSecret) {
      // Operator path, no rate limit: user_id is a telegramId, or else a DB id
      user = await getUserByTelegramId(user_id) ?? await getUserById(user_id);
      via = 'server';
    } else {
      // verifyUserAuth also rate limits (commandRateLimiter)
      const auth = await verifyUserAuth(request, String(user_id), initData, commandRateLimiter, 'execute-command');
      if (!auth.success) {
        return auth.response;
      }
      user = auth.user;
      via = auth.via;
    }

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // The answer goes to the proved user's own chat, never to a chat named by a DB id
    const target = resolveCommandTarget(user, via);
    if (!target) {
      return NextResponse.json(
        { success: false, error: 'no_channel' },
        { status: 400 }
      );
    }
    const { platform, chatId } = target;

    // Dynamically import to avoid build-time initialization
    const {
      handleSummaryCommand,
      handleWeatherCommand,
      handleLookaheadCommand,
      handleNextWeekCommand,
      getMessagingService,
    } = await import('@/src/services/telegram');

    // For user-invoked summary surfaces on Telegram, open a streaming draft
    // so the response animates in via sendMessageDraft. Other commands and
    // WhatsApp users keep the buffered path.
    const isStreamableCommand =
      command === 'summary' || command === 'lookahead' || command === 'nextweek';
    let streamHandle: import('@/src/services/messaging/types').StreamMessageHandle | undefined;
    if (platform === MessagingPlatform.TELEGRAM && isStreamableCommand) {
      try {
        const { getBotMessages } = await import('@/src/lib/bot-messages');
        const messages = await getBotMessages(user.language || 'en');
        // Use a neutral preparing message as the first placeholder. Each
        // command's handler updates the draft with stage-specific text as
        // it progresses through fetch → compose → stream.
        const placeholder = messages.streaming?.preparing ?? messages.streaming?.composing ?? '';
        const tgService = getMessagingService();
        streamHandle = await tgService.streamMessage(chatId, {
          initialPlaceholder: placeholder,
        });
      } catch (err) {
        captureError(err, 'execute-command-open-stream', { user_id, command }, 'warning');
        // Fall through — handlers default to buffered when streamHandle is undefined.
      }
    }

    // Schedule command to run after response is sent (keeps function alive)
    // Using Next.js `after()` to ensure background work completes
    after(async () => {
      try {
        switch (command) {
          case 'summary':
            await handleSummaryCommand(
              chatId,
              chatId,
              platform,
              args,
              streamHandle,
            );
            break;
          case 'weather':
            await handleWeatherCommand(
              chatId,
              chatId,
              platform,
              args,
            );
            break;
          case 'lookahead':
            await handleLookaheadCommand(
              chatId,
              chatId,
              platform,
              streamHandle,
            );
            break;
          case 'nextweek':
            await handleNextWeekCommand(
              chatId,
              chatId,
              platform,
              streamHandle,
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

        // Send error message to user. If the stream was opened, surface the
        // error via the draft handle so the placeholder/animation collapses
        // cleanly into a single error message.
        try {
          const { getBotMessages } = await import('@/src/lib/bot-messages');
          const messages = await getBotMessages(user.language || 'en');
          const errorMessage = messages.streaming?.failed
            ?? '❌ Sorry, something went wrong processing your request. Please try again.';
          if (streamHandle) {
            await streamHandle.cancel(errorMessage);
          } else if (platform === MessagingPlatform.TELEGRAM) {
            await getMessagingService().sendMessage(chatId, errorMessage);
          } else {
            await getPlatformService(platform).sendMessage(chatId, errorMessage);
          }
          trackActivityAsync(user.id, 'user_error_shown', { error_type: 'execute_command', command });
        } catch (notifyErr) {
          captureError(notifyErr, 'execute-command-notify', { user_id });
        }
      }
    });

    if (command !== 'summary' && command !== 'weather' && command !== 'lookahead' && command !== 'nextweek') {
      return NextResponse.json({
        success: false,
        error: `Unknown command: ${command}`
      }, { status: 400 });
    }

    // Return immediately — command continues executing via after()
    return NextResponse.json({
      success: true,
      message: 'Command started',
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
