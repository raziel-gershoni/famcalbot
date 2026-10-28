import { NextRequest, NextResponse, after } from 'next/server';
import { updateUserById } from '@/src/services/user-service';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { setUserMenuButton } from '@/src/services/telegram';
import { syncReminderCacheEntry } from '@/src/services/reminder-cache';
import { saveUserPlace } from '@/src/services/zmanim/place';
import { trackActivityAsync } from '@/src/services/analytics-service';
import { changedSettingFields } from '@/src/lib/settings-changes';
import { canReceiveReminderPings } from '@/src/services/native-reminders/support';
import { invalidateDueGate } from '@/src/services/native-reminders/due-gate';
import { isValidReminderTime, reminderTimeOf } from '@/src/lib/reminder-time';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json();
    const { language, location, messagingPlatform, culture, globalRules, name, textSummaryEnabled, voiceSummaryEnabled, weatherEnabled, includeLookaheadInTomorrow, lookaheadAlways7Days, preferredMorningHour, preferredEveningHour, dailySummaryDays, tomorrowSummaryDays, remindersEnabled, defaultReminderMinutes, reminderTime, pickupRemindersEnabled, voiceInputEnabled, initData } = body;

    // Authentication and rate limiting
    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'settings');
    if (!auth.success) {
      return auth.response;
    }

    // Input validation
    if (globalRules !== undefined) {
      if (!Array.isArray(globalRules) || globalRules.length > 3) {
        return NextResponse.json({ error: 'Invalid globalRules' }, { status: 400 });
      }
      for (const rule of globalRules) {
        if (typeof rule !== 'string' || rule.length > 200) {
          return NextResponse.json({ error: 'Rule too long (max 200 chars)' }, { status: 400 });
        }
      }
    }
    if (name !== undefined && (typeof name !== 'string' || name.length > 50)) {
      return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
    }
    if (reminderTime !== undefined && !isValidReminderTime(reminderTime)) {
      return NextResponse.json({ error: 'Invalid reminderTime' }, { status: 400 });
    }
    // The reminder time is for whoever FamCal reminders can ping (their own plan, or a partner's
    // reminders for them). When it isn't allowed, only that field is dropped: it must never
    // cost the rest of the save (a trial that ended while Settings was open, a switched-off plan).
    let acceptedReminderTime: string | undefined;
    if (isValidReminderTime(reminderTime)) {
      if (await canReceiveReminderPings(auth.user)) {
        acceptedReminderTime = reminderTime;
      } else {
        console.warn(`[settings] reminderTime ignored for user ${auth.user.id}: FamCal reminders can't ping them (no Telegram, switch off, or no plan for them or their partner); the rest of the save goes through`);
        captureError(new Error('reminderTime ignored: reminders not available'), 'settings-reminder-time', { api_route: '/api/settings', user_id: auth.user.id }, 'warning');
      }
    }
    const isValidDaysArray = (arr: unknown): arr is number[] =>
      Array.isArray(arr) && arr.length >= 1 && arr.length <= 7 &&
      arr.every((d: unknown) => typeof d === 'number' && d >= 0 && d <= 6);
    if (dailySummaryDays !== undefined && !isValidDaysArray(dailySummaryDays)) {
      return NextResponse.json({ error: 'Invalid dailySummaryDays' }, { status: 400 });
    }
    if (tomorrowSummaryDays !== undefined && !isValidDaysArray(tomorrowSummaryDays)) {
      return NextResponse.json({ error: 'Invalid tomorrowSummaryDays' }, { status: 400 });
    }

    // A changed location moves the cached timezone, and the coordinates and highest ground (zmanim),
    // with it: the zone would stay up to 24 h, and the coordinates for good. Compared trimmed, so spaces
    // alone are no change; an empty location is not saved (`location || undefined` below), so it
    // changes nothing here either.
    const newLocation = typeof location === 'string' ? location.trim() : '';
    const locationChanged = newLocation !== '' && newLocation !== (auth.user.location ?? '').trim();

    // auth.user is the row the credential proved (a Telegram user, or a WhatsApp session's DB id)
    const update = {
      language: language || undefined,  // Locale code: 'he', 'en', 'ru'
      location: location || undefined,
      messagingPlatform: messagingPlatform || undefined,
      culture: culture || undefined,
      globalRules: Array.isArray(globalRules) ? globalRules : undefined,
      textSummaryEnabled: typeof textSummaryEnabled === 'boolean' ? textSummaryEnabled : undefined,
      voiceSummaryEnabled: typeof voiceSummaryEnabled === 'boolean' ? voiceSummaryEnabled : undefined,
      weatherEnabled: typeof weatherEnabled === 'boolean' ? weatherEnabled : undefined,
      includeLookaheadInTomorrow: typeof includeLookaheadInTomorrow === 'boolean' ? includeLookaheadInTomorrow : undefined,
      lookaheadAlways7Days: typeof lookaheadAlways7Days === 'boolean' ? lookaheadAlways7Days : undefined,
      preferredMorningHour: typeof preferredMorningHour === 'number' ? preferredMorningHour : undefined,
      preferredEveningHour: typeof preferredEveningHour === 'number' ? preferredEveningHour : undefined,
      dailySummaryDays: isValidDaysArray(dailySummaryDays) ? dailySummaryDays : undefined,
      tomorrowSummaryDays: isValidDaysArray(tomorrowSummaryDays) ? tomorrowSummaryDays : undefined,
      remindersEnabled: typeof remindersEnabled === 'boolean' ? remindersEnabled : undefined,
      defaultReminderMinutes: typeof defaultReminderMinutes === 'number' ? defaultReminderMinutes : undefined,
      reminderTime: acceptedReminderTime,
      pickupRemindersEnabled: typeof pickupRemindersEnabled === 'boolean' ? pickupRemindersEnabled : undefined,
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined
    };
    // The old place's coordinates must never sit beside the new name, so a changed location clears them
    // in the same write; the lookup below fills them again (and the lazy fill does, if it fails).
    // Not part of `update`: they are no setting the person changed.
    const clearedPlace = locationChanged ? { latitude: null, longitude: null, elevationM: null } : {};
    const updatedUser = await updateUserById(auth.user.id, { ...update, ...clearedPlace });

    // The names of the fields this save changed, never their values; a save that changed nothing logs nothing.
    const changedFields = changedSettingFields(auth.user as unknown as Record<string, unknown>, update);
    if (changedFields.length > 0) trackActivityAsync(auth.user.id, 'settings_changed', { changed_fields: changedFields });

    // A new reminder time moves the date-only pings the due gate has memoed: wake the pass.
    if (acceptedReminderTime !== undefined && acceptedReminderTime !== reminderTimeOf(auth.user)) invalidateDueGate();

    // The lookup runs after the response, so the save answers at once. saveUserPlace is the one writer of
    // the coordinates and the highest ground, and it moves the cached zone with them.
    if (locationChanged) {
      const id = auth.user.id;
      after(() =>
        saveUserPlace(id, newLocation).catch(error =>
          captureError(error, 'settings-timezone', { api_route: '/api/settings', user_id: id }, 'warning')
        )
      );
    }

    // Update reminder cache (no extra DB query - uses data from updateUserById): who belongs in it
    // is the hourly sync's rule (syncReminderCacheEntry).
    await syncReminderCacheEntry(updatedUser);

    // Update menu button when language changes (Telegram users only; the chat is the telegramId)
    if (language && auth.user.telegramId) {
      await setUserMenuButton(Number(auth.user.telegramId), language);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    captureError(error, 'settings', { api_route: '/api/settings' });
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
