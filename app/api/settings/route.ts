import { NextRequest, NextResponse } from 'next/server';
import { updateUser } from '@/src/services/user-service';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { setUserMenuButton } from '@/src/services/telegram';
import { updateUserInCache, removeUserFromCache } from '@/src/services/reminder-cache';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json();
    const { language, location, messagingPlatform, culture, globalRules, name, textSummaryEnabled, voiceSummaryEnabled, weatherEnabled, includeLookaheadInTomorrow, lookaheadAlways7Days, preferredMorningHour, preferredEveningHour, dailySummaryDays, tomorrowSummaryDays, remindersEnabled, defaultReminderMinutes, pickupRemindersEnabled, voiceInputEnabled, voicePreference, voiceStyle, initData } = body;

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

    const updatedUser = await updateUser(auth.userId, {
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
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined,
      voicePreference: typeof voicePreference === 'string' ? voicePreference : undefined,
      voiceStyle: typeof voiceStyle === 'string' ? voiceStyle : undefined
    });

    // Update reminder cache (no extra DB query - uses data from updateUser)
    if (updatedUser.remindersEnabled && updatedUser.googleRefreshToken) {
      await updateUserInCache({
        id: updatedUser.id,
        telegramId: updatedUser.telegramId?.toString() ?? '',
        googleRefreshToken: updatedUser.googleRefreshToken, // Already decrypted by convertPrismaUserToConfig
        calendarAssignments: updatedUser.calendarAssignments,
        defaultReminderMinutes: updatedUser.defaultReminderMinutes ?? null,
        language: updatedUser.language,
        name: updatedUser.name,
        pickupRemindersEnabled: updatedUser.pickupRemindersEnabled ?? true,
      });
    } else {
      await removeUserFromCache(updatedUser.id);
    }

    // Update menu button when language changes
    if (language) {
      await setUserMenuButton(auth.userId, language);
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
