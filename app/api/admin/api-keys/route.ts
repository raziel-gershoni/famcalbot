/**
 * Admin API keys (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §2.1, §3.5): the keys of the owner's other
 * apps for the Jewish times API (/api/v1/*), in the blocklist route's pattern.
 * GET: every key, newest first: { success, keys: [{ id, appName, prefix, origins, createdAt, revokedAt }] } (never a hash).
 * POST { action: 'create', appName, origins }: origins as one string, one per line (or a list) → { success, key, id, prefix }.
 *   The key is in this answer only, which no cache keeps.
 * POST { action: 'revoke', id } → { success }. Revoking a revoked key writes the key list again and succeeds.
 * Errors are codes: 400 INVALID_NAME, INVALID_ORIGIN, TOO_MANY_KEYS, INVALID_REQUEST; 404 NOT_FOUND; 503 MIRROR_FAILED
 * ("Revoked, but the cache was not updated"); 500 INTERNAL.
 * initData: the X-Telegram-Init-Data header (GET), the header or the body's initData (POST), as the other admin routes.
 * Logs carry ids and codes only (store.ts): never a key, an app name or an origin; a failure is reported by its kind.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey, type ApiKeyErrorCode } from '@/src/services/api-keys/store';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/admin/api-keys';
const STATUS: Record<ApiKeyErrorCode, number> = { INVALID_NAME: 400, INVALID_ORIGIN: 400, TOO_MANY_KEYS: 400, NOT_FOUND: 404, MIRROR_FAILED: 503 };
const NO_STORE = { 'Cache-Control': 'no-store' };

const denied = (error: string | undefined) => NextResponse.json({ error }, { status: error === 'Admin access required' ? 403 : 401 });
const badRequest = () => NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAccess(requestInitData(request));
    if (!auth.authorized) return denied(auth.error);
    return NextResponse.json({ success: true, keys: await listApiKeys() }, { headers: NO_STORE });
  } catch (error) {
    captureSignInFailure(error, 'admin-api-keys-get', { api_route: ROUTE });
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    console.warn(`[api-keys] a POST whose body is no JSON (${error instanceof Error ? error.name : typeof error})`);
    return badRequest();
  }
  try {
    const auth = await verifyAdminAccess(requestInitData(request, body));
    if (!auth.authorized || auth.adminId === undefined) return denied(auth.error);
    if (body.action === 'create') {
      const created = await createApiKey(body.appName, body.origins, auth.adminId);
      return NextResponse.json({ success: true, ...created }, { headers: NO_STORE });
    }
    if (body.action === 'revoke') {
      const id = body.id;
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return badRequest();
      await revokeApiKey(id, auth.adminId);
      return NextResponse.json({ success: true });
    }
    return badRequest();
  } catch (error) {
    if (error instanceof ApiKeyError) {
      console.warn(`[api-keys] refused: ${error.code}`);
      return NextResponse.json({ error: error.code }, { status: STATUS[error.code] });
    }
    // By its kind only: a database error can print the row it was writing (the app's name, its origins)
    captureSignInFailure(error, 'admin-api-keys-post', { api_route: ROUTE });
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
