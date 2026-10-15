// POST /api/pair/accept — accept an invite as the authenticated user.
// Body: { token, initData? }. Returns { success: true, partnerName }.
//
// Validation lives in pairing-service.acceptInvite — this route just maps the
// PairingError codes onto HTTP responses. The inviter is told about the accept
// here, through the same helper the chat accept uses (pair-handler).

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { acceptInvite, PairingError } from '@/src/services/pairing-service';
import { notifyInviterOfAccept } from '@/src/services/telegram/pair-handler';
import { captureError } from '@/src/lib/error-capture';
import { prisma } from '@/src/utils/prisma';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json().catch(() => ({}));
    const initData = requestInitData(request, body);
    const token: string | undefined = body.token;

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'pair-accept');
    if (!auth.success) return auth.response;

    const user = auth.user;

    const result = await acceptInvite(token, user.id);

    // Tell the inviter (best effort: the helper catches and logs its own errors)
    await notifyInviterOfAccept(result.inviterUserId, user.name);

    // Inviter side: pull their name for the success response so the UI can
    // confirm "paired with X" without an extra round-trip.
    const inviter = await prisma.user.findUnique({
      where: { id: result.inviterUserId },
      select: { name: true, englishName: true },
    });

    return NextResponse.json({
      success: true,
      partner: { name: inviter?.name ?? '', englishName: inviter?.englishName ?? '' },
    });
  } catch (error) {
    if (error instanceof PairingError) {
      const status = error.code === 'INVITE_NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: error.code }, { status });
    }
    captureError(error, 'pair-accept');
    return NextResponse.json({ error: 'Failed to accept invite' }, { status: 500 });
  }
}
