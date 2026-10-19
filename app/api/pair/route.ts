// GET /api/pair — return active pairing status (partner info or null).
// DELETE /api/pair — unlink. Both partners' pairingId clears; UI updates next read.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { getActivePartner, unlink, PairingError } from '@/src/services/pairing-service';
import { captureError } from '@/src/lib/error-capture';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const initData = requestInitData(request);

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'pair-get');
    if (!auth.success) return auth.response;

    const user = auth.user;
    // native stays true for the client: everyone has FamCal, so anyone can pair.
    const result = await getActivePartner(user.id);
    if (!result) return NextResponse.json({ paired: false, native: true });

    return NextResponse.json({
      paired: true,
      native: true,
      partner: {
        name: result.partner.name,
        englishName: result.partner.englishName,
      },
      acceptedAt: result.pairing.acceptedAt,
    });
  } catch (error) {
    captureError(error, 'pair-get');
    return NextResponse.json({ error: 'Failed to load pairing' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json().catch(() => ({}));
    const initData = requestInitData(request, body);

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'pair-unlink');
    if (!auth.success) return auth.response;

    const user = auth.user;

    const result = await unlink(user.id);
    return NextResponse.json({ success: true, partnerUserId: result.partnerUserId });
  } catch (error) {
    if (error instanceof PairingError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    captureError(error, 'pair-unlink');
    return NextResponse.json({ error: 'Failed to unlink' }, { status: 500 });
  }
}
