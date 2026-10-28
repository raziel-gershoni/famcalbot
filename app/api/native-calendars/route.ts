// GET    /api/native-calendars — list calendars visible to the user (own + partner-shared)
// POST   /api/native-calendars — create a native calendar (name, color?, labels?)
//
// All writes go through the prisma client directly here because event-store.ts
// does not yet expose calendar CRUD (its scope is event-level). Permission
// model: only owner can create on their own user_id, no surprise here.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { listVisibleCalendars, encodeCalendarId, sortingForViewer } from '@/src/services/native-calendar/event-store';
import { calendarTotal, checkCalendarLimit, countCalendars } from '@/src/services/subscription-service';
import { prisma } from '@/src/utils/prisma';
import { captureError } from '@/src/lib/error-capture';
import { autoCalendarColour } from '@/src/services/native-calendar/colour';
import { addsPrimary, clearOtherPrimaries } from '@/src/services/calendar-provider/primary';

const VALID_LABELS = new Set(['primary', 'yours', 'spouse', 'kids', 'birthdays']);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const initData = requestInitData(request);

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'native-calendars-list');
    if (!auth.success) return auth.response;

    const user = auth.user;

    const calendars = await listVisibleCalendars(user.id, user.pairingId ?? null);
    return NextResponse.json({
      calendars: calendars.map((c) => ({
        id: encodeCalendarId(c.id),
        rawId: c.id,
        name: c.name,
        color: c.color,
        privacy: c.privacy,
        ownerUserId: c.ownerUserId,
        isOwner: c.ownerUserId === user.id,
        // The owner's labels, rules and person: a partner's calendar carries none of them
        ...sortingForViewer(c, user.id),
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
    const initData = requestInitData(request, body);

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'native-calendars-create');
    if (!auth.success) return auth.response;

    const user = auth.user;

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

    // Paywall: the shared total (own FamCal plus Google choices) after this one vs the limit.
    const counts = await countCalendars(user.id);
    const limit = await checkCalendarLimit(user.id, calendarTotal(counts.famcal + 1, counts.google));
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'calendar_limit_reached', limit: limit.limit, current: calendarTotal(counts.famcal, counts.google) },
        { status: 403 }
      );
    }

    const created = await prisma.nativeCalendar.create({
      data: {
        ownerUserId: user.id,
        name,
        // Unless the caller names one: the palette colour farthest from everything the user sees.
        color: color ?? (await autoCalendarColour(user)),
        labels,
        personName,
        personGender,
        // New calendars default to PRIVATE; user can flip in PATCH.
        privacy: 'PRIVATE',
      },
    });
    // A calendar created primary is the user's only primary, across both lists (spec §3).
    if (addsPrimary(null, labels)) await clearOtherPrimaries(user.id, { famcalId: created.id });

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
