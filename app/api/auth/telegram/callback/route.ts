import { NextRequest, NextResponse } from 'next/server';
import { handleOidcCallback } from '@/src/services/web-signin/oidc-route';
import { finishSignIn, landingPage, signInPageUrl } from '@/src/lib/web-session';
import { getUserByTelegramId } from '@/src/services/user-service';

/**
 * GET /api/auth/telegram/callback: Telegram sends the browser back here. The account is the one with the token's
 * Telegram user id (the `id` claim, never `sub`); none is the no-account page.
 */
export async function GET(request: NextRequest) {
  return handleOidcCallback('telegram', request, ['telegram'], async (claims, flow) => {
    const user = await getUserByTelegramId(claims.telegramId);
    if (!user) {
      console.info('[signin] telegram sign-in matched no account');
      return NextResponse.redirect(signInPageUrl(flow.locale, 'no-account'));
    }
    return finishSignIn(user, 'tg', { page: landingPage(flow.invite) });
  });
}
