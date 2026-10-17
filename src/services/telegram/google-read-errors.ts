import { MessageFormat, type IMessagingService } from '../messaging';
import type { StreamMessageHandle } from '../messaging/types';
import { getBotMessages } from '../../lib/bot-messages';
import type { UserConfig } from '../../types';

/**
 * The answers to Google's failures, shared by the on-demand daily summary, /week and
 * /nextweek (Ruling R14: one copy, so they cannot drift):
 * - a dead token or missing permissions get the token / scopes texts and an admin warning;
 *   missing permissions also clear the token;
 * - an outage (R13), after the reader's quick retry, gets "couldn't reach Google Calendar"
 *   with no admin notice; an open draft collapses into the answer.
 * Returns false for anything else, so the pipeline's own error text and admin notice apply.
 */
export async function answerGoogleReadError(
  error: Error,
  ctx: {
    chatId: number | string;
    user: UserConfig;
    userLanguage: string;
    messagingService: IMessagingService;
    streamHandle?: StreamMessageHandle;
  }
): Promise<boolean> {
  const { chatId, user, userLanguage, messagingService, streamHandle } = ctx;

  if (error.message === 'GOOGLE_INSUFFICIENT_SCOPES') {
    const t = await getBotMessages(userLanguage);
    const scopesMessage = `${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`;
    await messagingService.sendMessage(chatId, scopesMessage, { format: MessageFormat.HTML });

    if (user.telegramId) {
      const { clearGoogleRefreshToken } = await import('../user-service');
      await clearGoogleRefreshToken(BigInt(user.telegramId));
    }

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Insufficient Scopes',
      `User ${user.id} has a token with insufficient scopes. Token cleared, awaiting re-authorization.`
    );
    return true;
  }

  if (error.message === 'GOOGLE_TOKEN_EXPIRED') {
    const t = await getBotMessages(userLanguage);
    const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;
    await messagingService.sendMessage(chatId, expiredMessage, { format: MessageFormat.HTML });

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Token Expired',
      `User ${user.id} needs to refresh their Google Calendar token`
    );
    return true;
  }

  // Ruling R13: Google couldn't be reached, even after the reader's quick retry. It isn't
  // the user's token, so they're told to try again in a minute, and no admin is paged.
  if (error.message === 'GOOGLE_FETCH_FAILED') {
    const t = await getBotMessages(userLanguage);
    const unreachable: string = t.errors.googleUnreachable;
    if (streamHandle) {
      await streamHandle.cancel(unreachable, { format: MessageFormat.HTML });
    } else {
      await messagingService.sendMessage(chatId, unreachable, { format: MessageFormat.HTML });
    }
    return true;
  }

  return false;
}
