// PATCH  /api/native-calendars/:id  — partial update of a native calendar.
// DELETE /api/native-calendars/:id  — soft-delete (sets isDeleted=true).
//
// Only the calendar's owner can patch or delete. Privacy changes are owner-only
// — partner cannot raise/lower their own visibility on the calendar.
//
// The copy to Google (google-sync spec §2): a rename marks the calendar's copy, so the
// worker renames its Google calendar; a delete turns the copy off, with body
// `googleCopy: 'remove' | 'keep'` (absent = keep) for the worker to carry out.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { prisma } from '@/src/utils/prisma';
import { captureError } from '@/src/lib/error-capture';
import { addsPrimary, clearOtherPrimaries } from '@/src/services/calendar-provider/primary';
import { markSyncDirty, markedTransaction, unlinkSync, type UnlinkChoice } from '@/src/services/google-sync/marks';

const VALID_LABELS = new Set(['primary', 'yours', 'spouse', 'kids', 'birthdays']);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const VALID_PRIVACIES = new Set(['PRIVATE', 'SHARED_VIEWER', 'SHARED_EDITOR']);
const GOOGLE_COPY_CHOICES = new Set<UnlinkChoice>(['remove', 'keep']);

interface PathProps {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: PathProps) {
  const { id: calendarId } = await params;
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json();
    const initData = requestInitData(request, body);

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'native-calendar-patch');
    if (!auth.success) return auth.response;

    const user = auth.user;

    const calendar = await prisma.nativeCalendar.findUnique({ where: { id: calendarId } });
    if (!calendar || calendar.isDeleted) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (calendar.ownerUserId !== user.id) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    // Field validation. Only validate the keys actually present in the body.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: any = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) {
        return NextResponse.json({ error: 'invalid_name' }, { status: 400 });
      }
      update.name = body.name.trim();
    }
    if (body.color !== undefined) {
      if (typeof body.color !== 'string' || !HEX_COLOR_RE.test(body.color)) {
        return NextResponse.json({ error: 'invalid_color' }, { status: 400 });
      }
      update.color = body.color;
    }
    if (body.labels !== undefined) {
      if (!Array.isArray(body.labels)) {
        return NextResponse.json({ error: 'invalid_labels' }, { status: 400 });
      }
      for (const label of body.labels) {
        if (!VALID_LABELS.has(label)) {
          return NextResponse.json({ error: 'invalid_label' }, { status: 400 });
        }
      }
      update.labels = body.labels;
    }
    if (body.privacy !== undefined) {
      if (!VALID_PRIVACIES.has(body.privacy)) {
        return NextResponse.json({ error: 'invalid_privacy' }, { status: 400 });
      }
      update.privacy = body.privacy;
    }
    if (body.personName !== undefined) {
      if (body.personName !== null && (typeof body.personName !== 'string' || body.personName.length > 50)) {
        return NextResponse.json({ error: 'person_name_too_long' }, { status: 400 });
      }
      update.personName = body.personName;
    }
    if (body.personEnglishName !== undefined) {
      update.personEnglishName = body.personEnglishName;
    }
    if (body.personGender !== undefined) {
      update.personGender = body.personGender;
    }
    if (body.rules !== undefined) {
      if (!Array.isArray(body.rules) || body.rules.length > 1) {
        return NextResponse.json({ error: 'invalid_rules' }, { status: 400 });
      }
      for (const rule of body.rules) {
        if (typeof rule !== 'string' || rule.length > 200) {
          return NextResponse.json({ error: 'rule_too_long' }, { status: 400 });
        }
      }
      update.rules = body.rules;
    }

    // A new name reaches the calendar's Google copy: the mark commits with the rename.
    const renamed = update.name !== undefined && update.name !== calendar.name;
    const updated = renamed
      ? await markedTransaction(async (tx) => {
          const row = await tx.nativeCalendar.update({ where: { id: calendar.id }, data: update });
          await markSyncDirty(tx, { calendarId: calendar.id });
          return row;
        })
      : await prisma.nativeCalendar.update({ where: { id: calendar.id }, data: update });
    // One primary across both lists, only when this save adds it (spec §3): a rename or a
    // label toggle that resends primary as it was touches nothing else.
    if (update.labels && addsPrimary(calendar.labels, update.labels)) {
      await clearOtherPrimaries(user.id, { famcalId: calendar.id });
    }
    return NextResponse.json({ success: true, calendar: updated });
  } catch (error) {
    captureError(error, 'native-calendar-patch', { calendarId });
    return NextResponse.json({ error: 'Failed to update calendar' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: PathProps) {
  const { id: calendarId } = await params;
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json().catch(() => ({}));
    const initData = requestInitData(request, body);

    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'native-calendar-delete');
    if (!auth.success) return auth.response;

    const user = auth.user;

    // What happens to the calendar's Google copy, if it has one: Keep unless asked.
    const googleCopy = (body?.googleCopy ?? 'keep') as UnlinkChoice;
    if (!GOOGLE_COPY_CHOICES.has(googleCopy)) {
      return NextResponse.json({ error: 'invalid_google_copy' }, { status: 400 });
    }

    const calendar = await prisma.nativeCalendar.findUnique({ where: { id: calendarId } });
    if (!calendar || calendar.isDeleted) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (calendar.ownerUserId !== user.id) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    // Refuse to delete the last calendar owned by this user — prevents the
    // empty-state UX bug where voice CRUD silently fails on next interaction.
    const otherOwned = await prisma.nativeCalendar.count({
      where: { ownerUserId: user.id, isDeleted: false, id: { not: calendar.id } },
    });
    if (otherOwned === 0) {
      return NextResponse.json({ error: 'cannot_delete_last' }, { status: 400 });
    }

    const turnedOff = await markedTransaction(async (tx) => {
      await tx.nativeCalendar.update({
        where: { id: calendar.id },
        data: { isDeleted: true },
      });
      return unlinkSync(tx, { calendarIds: [calendar.id] }, googleCopy);
    });
    if (turnedOff > 0) console.log(`[GoogleSync] Calendar ${calendar.id} deleted: its copy turned off (${googleCopy})`);
    return NextResponse.json({ success: true });
  } catch (error) {
    captureError(error, 'native-calendar-delete', { calendarId });
    return NextResponse.json({ error: 'Failed to delete calendar' }, { status: 500 });
  }
}
