import { NextRequest, NextResponse, after } from 'next/server';
import { updateUserById } from '@/src/services/user-service';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { setUserMenuButton } from '@/src/services/telegram';
import { updateUserInCache, removeUserFromCache } from '@/src/services/reminder-cache';
import { resolveTimezoneForLocation } from '@/src/lib/timezone';
import { redis } from '@/src/utils/redis';
import { prisma } from '@/src/utils/prisma';
import { REDIS_KEYS } from '@/src/config/redis-keys';

const TIMEZONE_CACHE_TTL = 24 * 60 * 60; // as resolveUserTimezone caches it

/**
 * Caches the zone of a newly saved location (`location` is trimmed). A failed lookup
 * leaves the cached zone as it is. So does a location that changed again while the lookup
 * ran: two quick saves each schedule a lookup, and the older one can land last.
 */
async function refreshTimezone(userId: number, location: string): Promise<void> {
  const tz = await resolveTimezoneForLocation(location);
  if (!tz) return;
  // Compared trimmed, as the save compares it. A row that is gone reads as ''.
  const stored = await prisma.user.findUnique({ where: { id: userId }, select: { location: true } });
  if ((stored?.location ?? '').trim() !== location) return;
  await redis.set(REDIS_KEYS.userTimezone(userId), tz, { ex: TIMEZONE_CACHE_TTL });
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json();
    const { language, location, messagingPlatform, culture, globalRules, name, textSummaryEnabled, voiceSummaryEnabled, weatherEnabled, includeLookaheadInTomorrow, lookaheadAlways7Days, preferredMorningHour, preferredEveningHour, dailySummaryDays, tomorrowSummaryDays, remindersEnabled, defaultReminderMinutes, pickupRemindersEnabled, voiceInputEnabled, initData } = body;

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
    const isValidDaysArray = (arr: unknown): arr is number[] =>
      Array.isArray(arr) && arr.length >= 1 && arr.length <= 7 &&
      arr.every((d: unknown) => typeof d === 'number' && d >= 0 && d <= 6);
    if (dailySummaryDays !== undefined && !isValidDaysArray(dailySummaryDays)) {
      return NextResponse.json({ error: 'Invalid dailySummaryDays' }, { status: 400 });
    }
    if (tomorrowSummaryDays !== undefined && !isValidDaysArray(tomorrowSummaryDays)) {
      return NextResponse.json({ error: 'Invalid tomorrowSummaryDays' }, { status: 400 });
    }

    // A changed location moves the cached timezone with it (else the old zone stays up to 24 h).
    // Compared trimmed, so spaces alone are no change; an empty location is not saved
    // (`location || undefined` below), so it changes nothing here either.
    const newLocation = typeof location === 'string' ? location.trim() : '';
    const locationChanged = newLocation !== '' && newLocation !== (auth.user.location ?? '').trim();

    // auth.user is the row the credential proved (a Telegram user, or a WhatsApp session's DB id)
    const updatedUser = await updateUserById(auth.user.id, {
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
      pickupRemindersEnabled: typeof pickupRemindersEnabled === 'boolean' ? pickupRemindersEnabled : undefined,
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined
    });

    // The lookup runs after the response, so the save answers at once.
    if (locationChanged) {
      const id = auth.user.id;
      after(() =>
        refreshTimezone(id, newLocation).catch(error =>
          captureError(error, 'settings-timezone', { api_route: '/api/settings', user_id: id }, 'warning')
        )
      );
    }

    // Update reminder cache (no extra DB query - uses data from updateUserById). Who belongs
    // in it is the hourly sync's rule (handleDailySummary): a NATIVE user has no Google
    // token by definition, and a save must not put back a suspended or unreachable user
    // the sync left out (Telegram refuses an unreachable chat every 5 minutes).
    const remindable = updatedUser.remindersEnabled &&
      updatedUser.telegramId !== null &&
      !updatedUser.suspendedAt &&
      !updatedUser.unreachableSince &&
      (!!updatedUser.googleRefreshToken || updatedUser.calendarSource === 'NATIVE');
    if (remindable) {
      await updateUserInCache({
        id: updatedUser.id,
        telegramId: updatedUser.telegramId?.toString() ?? '',
        googleRefreshToken: updatedUser.googleRefreshToken, // Already decrypted by convertPrismaUserToConfig
        calendarAssignments: updatedUser.calendarAssignments,
        calendarSource: updatedUser.calendarSource,
        pairingId: updatedUser.pairingId,
        defaultReminderMinutes: updatedUser.defaultReminderMinutes ?? null,
        language: updatedUser.language,
        name: updatedUser.name,
        pickupRemindersEnabled: updatedUser.pickupRemindersEnabled ?? true,
        location: updatedUser.location,
      });
    } else {
      await removeUserFromCache(updatedUser.id);
    }

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
