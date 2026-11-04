import { NextRequest, NextResponse } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { completeSignUp, signUpView, type SignUpBody } from '@/src/services/web-signin/signup';
import { captureSignInFailure, safeErrorSummary } from '@/src/services/web-signin/safe-error';

const ROUTE = '/api/auth/signup';
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/auth/signup (web sign-up spec §3.4): the sign-up waiting in this browser (the famcal_signin cookie, path
 * /api/auth, so /signup itself can't read it), without using it up: { way, address }, { exists: way } when another
 * account's way shows the address, or { restart: true }. Never cached. A failure is { failed: true } (500), reported by
 * its kind only.
 */
export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await signUpView(request), { headers: NO_STORE });
  } catch (error) {
    captureSignInFailure(error, 'signup-view', { api_route: ROUTE });
    return NextResponse.json({ failed: true }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/auth/signup { name, locale }: Create account (signup.ts completeSignUp), after the same-origin check and
 * the JSON read. A failure past them is { ok: false, status: 'failed' } (500), reported by its kind only.
 */
export async function POST(request: NextRequest) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    console.warn(`[signup] a Create account whose body is not JSON: ${safeErrorSummary(error)}`);
    return NextResponse.json({ ok: false, status: 'failed' }, { status: 400 });
  }
  try {
    return await completeSignUp(request, body !== null && typeof body === 'object' ? (body as SignUpBody) : {});
  } catch (error) {
    captureSignInFailure(error, 'signup-complete', { api_route: ROUTE });
    return NextResponse.json({ ok: false, status: 'failed' }, { status: 500 });
  }
}
