/**
 * Admin Open Profile API
 * POST { userId }: the way into a person's Telegram profile from the admin panel (menu-revamp spec §6).
 * Answers 200 { kind: 'link', url } (their public t.me link) or { kind: 'sent' } (a mention was sent to the admin's own
 * chat), 404 for a person with no Telegram id, 502 when the mention could not be sent. The logic is in
 * src/services/admin-open-profile.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';
import { requestInitData } from '@/src/lib/request-init-data';
import { extractUserId } from '@/src/lib/telegram-auth';
import { openProfileAnswer, openProfileFor } from '@/src/services/admin-open-profile';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== 'object') {
      return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
    }

    const initData = requestInitData(request, body);
    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json({ error: auth.error }, { status: auth.error === 'Admin access required' ? 403 : 401 });
    }

    const { userId } = body as { userId?: unknown };
    if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ error: 'userId is required and must be a number' }, { status: 400 });
    }

    // verifyAdminAccess has checked the signature, so the id is the admin's own Telegram id
    const adminTelegramId = initData ? extractUserId(initData) : null;
    if (adminTelegramId === null) {
      return NextResponse.json({ error: 'Invalid initData' }, { status: 401 });
    }

    const answer = openProfileAnswer(await openProfileFor(adminTelegramId, userId));
    return NextResponse.json(answer.body, { status: answer.status });
  } catch (error) {
    captureError(error, 'admin-open-profile-post', { api_route: '/api/admin/open-profile' });
    console.error('[admin-open-profile] Error:', error);
    return NextResponse.json({ error: 'Failed to open the profile' }, { status: 500 });
  }
}
