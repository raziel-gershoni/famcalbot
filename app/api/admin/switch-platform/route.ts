/**
 * Admin Switch Platform API
 * POST: Set WhatsApp number for a user and switch them to WhatsApp
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { captureError } from '@/src/lib/error-capture';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { initData, user_id, whatsapp_phone } = body;

    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json(
        { error: 'user_id is required and must be a number' },
        { status: 400 }
      );
    }

    if (!whatsapp_phone || typeof whatsapp_phone !== 'string') {
      return NextResponse.json(
        { error: 'whatsapp_phone is required' },
        { status: 400 }
      );
    }

    // Validate E.164 format (+ followed by digits, 7-15 chars)
    const cleaned = whatsapp_phone.trim();
    if (!/^\+\d{7,15}$/.test(cleaned)) {
      return NextResponse.json(
        { error: 'Invalid phone format. Use E.164 format: +972501234567' },
        { status: 400 }
      );
    }

    // Check user exists
    const user = await prisma.user.findUnique({
      where: { id: user_id },
      select: { id: true, name: true, telegramId: true, whatsappPhone: true, messagingPlatform: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Check if phone is already used by another user
    const existingUser = await prisma.user.findFirst({
      where: { whatsappPhone: cleaned, id: { not: user_id } },
      select: { id: true, name: true },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: `Phone ${cleaned} is already used by user ${existingUser.name} (ID: ${existingUser.id})` },
        { status: 409 }
      );
    }

    // Update user: set WhatsApp phone and switch platform to 'whatsapp'
    await prisma.user.update({
      where: { id: user_id },
      data: {
        whatsappPhone: cleaned,
        messagingPlatform: 'whatsapp',
      },
    });

    console.log(`[switch-platform] Admin ${auth.adminId} set WhatsApp ${cleaned} for user ${user_id} (${user.name}), switched platform to whatsapp`);

    return NextResponse.json({
      success: true,
      message: `Set WhatsApp ${cleaned} for ${user.name} and switched to WhatsApp`,
      previousPlatform: user.messagingPlatform,
    });
  } catch (error) {
    captureError(error, 'switch-platform-post', { api_route: '/api/admin/switch-platform' });
    console.error('[switch-platform] Error:', error);
    return NextResponse.json(
      { error: 'Failed to switch platform' },
      { status: 500 }
    );
  }
}
