import { NextRequest } from 'next/server';
import { startOidcSignIn } from '@/src/services/web-signin/oidc-route';

/** GET /api/auth/google/start?locale=: to Google's sign-in, for "Continue with Google" on /signin. */
export async function GET(request: NextRequest) {
  return startOidcSignIn('google', request);
}
