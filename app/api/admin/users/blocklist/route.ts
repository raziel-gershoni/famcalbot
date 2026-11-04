/**
 * Admin Identifier Blocklist API (web sign-up spec §2.8, §3.8)
 * GET: every blocked identifier, as the list shows it: { id, kind, shown, bannedBy, bannedReason, createdAt } (a Google
 *   account by the last 4 of its id, an address masked; never the whole id or address).
 * POST { action: 'ban', user_id, reason? }: blocks everything that account signs in with (its Telegram id, WhatsApp
 *   number, Google account and sign-in address; a browser-only account included) → { success, kinds }.
 * POST { action: 'ban', telegramId?, whatsappPhone?, reason? }: a bare Telegram id or WhatsApp number, as before.
 * POST { action: 'unban', entryId } (one entry of the list), or { user_id }, or a bare telegramId / whatsappPhone.
 * A ban of the acting admin's own account, Telegram id or WhatsApp number answers 400 { error: 'SELF_BAN' }, as the
 * moderation route refuses an admin's own account. No such account or entry: 404 { error: 'NOT_FOUND' }; an account
 * with nothing to block: 400 { error: 'NO_IDENTIFIER' }.
 *
 * The blocklist persists independently of User rows, so a banned identifier cannot sign up again, even after a hard
 * delete.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { banIdentifier, unbanIdentifier, listBlockedIdentifiers, BanTargetError } from '@/src/lib/user-moderation';

export const dynamic = 'force-dynamic';

/** A database id the body names (user_id, entryId), or null. */
const positiveId = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);

export async function GET(request: NextRequest) {
  try {
    const initData = requestInitData(request);
    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    const blocklist = await listBlockedIdentifiers();
    return NextResponse.json({ success: true, blocklist });
  } catch (error) {
    captureError(error, 'admin-users-blocklist-get', { api_route: '/api/admin/users/blocklist' });
    return NextResponse.json({ error: 'Failed to fetch blocklist' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, action, telegramId, whatsappPhone, reason } = body;

    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    const userId = positiveId(body.user_id);
    const entryId = positiveId(body.entryId);
    const tgId: number | null = typeof telegramId === 'number' ? telegramId
      : typeof telegramId === 'string' && telegramId.trim() ? Number(telegramId)
      : null;
    const phone: string | null = typeof whatsappPhone === 'string' && whatsappPhone.trim() ? whatsappPhone.trim() : null;

    if (tgId !== null && Number.isNaN(tgId)) {
      return NextResponse.json({ error: 'telegramId must be a number' }, { status: 400 });
    }
    if (userId === null && entryId === null && !tgId && !phone) {
      return NextResponse.json(
        { error: 'An account (user_id), an entry (entryId), or a telegramId or whatsappPhone is required' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'ban': {
        if (userId !== null) {
          if (userId === auth.adminId) {
            return NextResponse.json({ error: 'SELF_BAN' }, { status: 400 });
          }
          const { kinds } = await banIdentifier({ userId }, auth.adminId!, reason ?? null);
          return NextResponse.json({ success: true, message: 'Account banned', kinds });
        }
        if (!tgId && !phone) {
          return NextResponse.json({ error: 'A ban takes user_id, or a telegramId or whatsappPhone' }, { status: 400 });
        }
        const own = await prisma.user.findUnique({ where: { id: auth.adminId! }, select: { telegramId: true, whatsappPhone: true } });
        const digits = (value: string) => value.replace(/\D/g, '');
        const banningSelf =
          (tgId !== null && own?.telegramId != null && String(own.telegramId) === String(tgId)) ||
          (phone !== null && own?.whatsappPhone != null && digits(own.whatsappPhone) === digits(phone));
        if (banningSelf) {
          return NextResponse.json({ error: 'SELF_BAN' }, { status: 400 });
        }
        const { kinds } = await banIdentifier({ telegramId: tgId, whatsappPhone: phone }, auth.adminId!, reason ?? null);
        return NextResponse.json({ success: true, message: 'Identifier banned', kinds });
      }
      case 'unban': {
        const target = entryId !== null ? { entryId } : userId !== null ? { userId } : { telegramId: tgId, whatsappPhone: phone };
        const { kinds } = await unbanIdentifier(target, auth.adminId!);
        return NextResponse.json({ success: true, message: 'Identifier unbanned', kinds });
      }
      default:
        return NextResponse.json({ error: 'action must be "ban" or "unban"' }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof BanTargetError) {
      console.warn(`[admin-blocklist] refused: ${error.code}`);
      return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 400 });
    }
    captureError(error, 'admin-users-blocklist-post', { api_route: '/api/admin/users/blocklist' });
    return NextResponse.json({ error: 'Failed to update blocklist' }, { status: 500 });
  }
}
