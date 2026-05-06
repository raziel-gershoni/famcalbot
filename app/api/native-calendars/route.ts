// GET    /api/native-calendars — list calendars visible to the user (own + partner-shared)
// POST   /api/native-calendars — create a native calendar (name, color?, labels?)
//
// All writes go through the prisma client directly here because event-store.ts
// does not yet expose calendar CRUD (its scope is event-level). Permission
// model: only owner can create on their own user_id, no surprise here.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { getUserByIdentifier } from '@/src/services/user-service';
import { listVisibleCalendars, encodeCalendarId } from '@/src/services/native-calendar/event-store';
import { checkCalendarLimit } from '@/src/services/subscription-service';
import { prisma } from '@/src/utils/prisma';
import { captureError } from '@/src/lib/error-capture';

const VALID_LABELS = new Set(['primary', 'yours', 'spouse', 'kids', 'birthdays']);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const initData = searchParams.get('initData');

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'native-calendars-list');
    if (!auth.success) return auth.response;

    const user = await getUserByIdentifier(auth.userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const calendars = await listVisibleCalendars(user.id, user.pairingId ?? null);
    return NextResponse.json({
      calendars: calendars.map((c) => ({
        id: encodeCalendarId(c.id),
        rawId: c.id,
        name: c.name,
        color: c.color,
        labels: c.labels,
        privacy: c.privacy,
        ownerUserId: c.ownerUserId,
        isOwner: c.ownerUserId === user.id,
        personName: c.personName,
        personEnglishName: c.personEnglishName,
        personGender: c.personGender,
        rules: c.rules,
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    captureError(error, 'native-calendars-list');
    return NextResponse.json({ error: 'Failed to load calendars' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json();
    const initData = body.initData ?? searchParams.get('initData');

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'native-calendars-create');
    if (!auth.success) return auth.response;

    const user = await getUserByIdentifier(auth.userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (user.calendarSource !== 'NATIVE') {
      return NextResponse.json({ error: 'native_only' }, { status: 400 });
    }

    const name: string | undefined = body.name?.trim();
    const color: string | undefined = body.color;
    const labels: string[] = Array.isArray(body.labels) ? body.labels : [];
    const personName: string | undefined = body.personName?.trim();
    const personGender: string | undefined = body.personGender;

    if (!name || name.length > 60) {
      return NextResponse.json({ error: 'invalid_name' }, { status: 400 });
    }
    if (color && !HEX_COLOR_RE.test(color)) {
      return NextResponse.json({ error: 'invalid_color' }, { status: 400 });
    }
    for (const label of labels) {
      if (!VALID_LABELS.has(label)) {
        return NextResponse.json({ error: 'invalid_label' }, { status: 400 });
      }
    }
    if (personName !== undefined && personName.length > 50) {
      return NextResponse.json({ error: 'person_name_too_long' }, { status: 400 });
    }

    // Paywall: count existing non-deleted calendars vs subscription limit.
    const existing = await prisma.nativeCalendar.count({
      where: { ownerUserId: user.id, isDeleted: false },
    });
    const limit = await checkCalendarLimit(user.id, existing + 1);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'calendar_limit_reached', limit: limit.limit, current: existing },
        { status: 403 }
      );
    }

    const created = await prisma.nativeCalendar.create({
      data: {
        ownerUserId: user.id,
        name,
        color: color ?? '#039BE5',
        labels,
        personName,
        personGender,
        // New calendars default to PRIVATE; user can flip in PATCH.
        privacy: 'PRIVATE',
      },
    });

    return NextResponse.json({
      success: true,
      calendar: {
        id: encodeCalendarId(created.id),
        rawId: created.id,
        name: created.name,
        color: created.color,
        labels: created.labels,
        privacy: created.privacy,
      },
    });
  } catch (error) {
    captureError(error, 'native-calendars-create');
    return NextResponse.json({ error: 'Failed to create calendar' }, { status: 500 });
  }
}
