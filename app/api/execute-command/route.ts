import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getUserByTelegramId, getUserById } from '@/src/services/user-service';
import { MessagingPlatform } from '@/src/services/messaging';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { validateSessionFromRequest } from '@/src/lib/session-auth';
import { checkRateLimit, commandRateLimiter, getRateLimitHeaders } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, command, args, secret, initData } = body;

    // Validate required parameters
    if (!user_id || !command) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: user_id, command'
      }, { status: 400 });
    }

    // Authentication: server secret OR Telegram initData OR session cookie
    const hasServerSecret = secret && secret === process.env.CRON_SECRET;
    const hasTelegramAuth = initData && verifyUserAccess(initData, user_id);
    const sessionUserId = validateSessionFromRequest(request);
    const hasSessionAuth = sessionUserId !== null && sessionUserId === user_id;

    if (!hasServerSecret && !hasTelegramAuth && !hasSessionAuth) {
      console.warn(`[execute-command] Unauthorized: user_id=${user_id} (${typeof user_id}), sessionUserId=${sessionUserId} (${typeof sessionUserId}), hasCookie=${!!request.cookies.get('famcal_session')}`);
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

    // Now get user from database — try Telegram ID first, fall back to DB ID
    const user = await getUserByTelegramId(user_id) ?? await getUserById(user_id);
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // Determine platform and chat ID based on auth method
    const platform = hasTelegramAuth || hasServerSecret
      ? MessagingPlatform.TELEGRAM
      : (user.whatsappPhone ? MessagingPlatform.WHATSAPP : MessagingPlatform.TELEGRAM);
    const { getWhatsAppChatId } = await import('@/src/services/user-service');
    const chatId: number | string = platform === MessagingPlatform.WHATSAPP && getWhatsAppChatId(user)
      ? getWhatsAppChatId(user)!
      : (user.telegramId ?? user_id);

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
        const placeholder = messages.streaming?.composing ?? '';
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
          } else {
            const messagingService = getMessagingService();
            await messagingService.sendMessage(user_id, errorMessage);
          }
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
