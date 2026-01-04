import { NextRequest, NextResponse } from 'next/server';
import { updateUser } from '@/src/services/user-service';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { setUserMenuButton } from '@/src/services/telegram';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    const body = await request.json();
    const { language, location, messagingPlatform, culture, globalRules, textSummaryEnabled, voiceSummaryEnabled, weatherEnabled, includeLookaheadInTomorrow, lookaheadAlways7Days, remindersEnabled, defaultReminderMinutes, voiceInputEnabled, initData } = body;

    // Authentication and rate limiting
    const auth = await verifyUserAuth(request, userId, initData, settingsRateLimiter, 'settings');
    if (!auth.success) {
      return auth.response;
    }

    await updateUser(auth.userId, {
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
      remindersEnabled: typeof remindersEnabled === 'boolean' ? remindersEnabled : undefined,
      defaultReminderMinutes: typeof defaultReminderMinutes === 'number' ? defaultReminderMinutes : undefined,
      voiceInputEnabled: typeof voiceInputEnabled === 'boolean' ? voiceInputEnabled : undefined
    });

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
