import { NextRequest } from 'next/server';
import { startOidcSignIn } from '@/src/services/web-signin/oidc-route';

/** GET /api/auth/telegram/start?locale=: to Telegram's login, for "Continue with Telegram" on /signin. */
export async function GET(request: NextRequest) {
  return startOidcSignIn('telegram', request);
}
