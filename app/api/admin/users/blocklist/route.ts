/**
 * Admin Identifier Blocklist API
 * GET: list all currently blocked identifiers (telegramId / whatsappPhone)
 * POST: { action: 'ban' | 'unban', telegramId?, whatsappPhone?, reason? }
 *   A ban of the acting admin's own Telegram id or WhatsApp number answers 400 { error: 'SELF_BAN' }, as the
 *   moderation route refuses an admin's own account.
 *
 * The blocklist persists independently of User rows, so a banned identifier
 * cannot re-register even after a hard-delete.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { banIdentifier, unbanIdentifier, listBlockedIdentifiers } from '@/src/lib/user-moderation';

export const dynamic = 'force-dynamic';

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

    const tgId: number | null = typeof telegramId === 'number' ? telegramId
      : typeof telegramId === 'string' && telegramId.trim() ? Number(telegramId)
      : null;
    const phone: string | null = typeof whatsappPhone === 'string' && whatsappPhone.trim() ? whatsappPhone.trim() : null;

    if (tgId !== null && Number.isNaN(tgId)) {
      return NextResponse.json({ error: 'telegramId must be a number' }, { status: 400 });
    }
    if (!tgId && !phone) {
      return NextResponse.json(
        { error: 'At least one of telegramId or whatsappPhone is required' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'ban': {
        const own = await prisma.user.findUnique({ where: { id: auth.adminId! }, select: { telegramId: true, whatsappPhone: true } });
        const digits = (value: string) => value.replace(/\D/g, '');
        const banningSelf =
          (tgId !== null && own?.telegramId != null && String(own.telegramId) === String(tgId)) ||
          (phone !== null && own?.whatsappPhone != null && digits(own.whatsappPhone) === digits(phone));
        if (banningSelf) {
          return NextResponse.json({ error: 'SELF_BAN' }, { status: 400 });
        }
        await banIdentifier({ telegramId: tgId, whatsappPhone: phone }, auth.adminId!, reason ?? null);
        return NextResponse.json({ success: true, message: 'Identifier banned' });
      }
      case 'unban': {
        await unbanIdentifier({ telegramId: tgId, whatsappPhone: phone }, auth.adminId!);
        return NextResponse.json({ success: true, message: 'Identifier unbanned' });
      }
      default:
        return NextResponse.json({ error: 'action must be "ban" or "unban"' }, { status: 400 });
    }
  } catch (error) {
    captureError(error, 'admin-users-blocklist-post', { api_route: '/api/admin/users/blocklist' });
    return NextResponse.json({ error: 'Failed to update blocklist' }, { status: 500 });
  }
}
