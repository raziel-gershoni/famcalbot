/**
 * WhatsApp Conversational Onboarding
 * Simple state machine for basic setup (language) via WhatsApp messages.
 * Complex flows (Google OAuth, calendar selection) redirect to web app via magic link.
 */

import { Redis } from '@upstash/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { updateUserById } from './user-service';
import { generateMagicLink } from './magic-link';
import { getWhatsAppService } from './messaging';
import { UserConfig } from '../types';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ONBOARD_TTL = 3600; // 1 hour

type OnboardStep = 'language' | 'done';

interface OnboardState {
  step: OnboardStep;
  userId: number;
}

/**
 * Start onboarding for a new WhatsApp user
 */
export async function startOnboarding(phone: string, user: UserConfig): Promise<void> {
  const state: OnboardState = { step: 'language', userId: user.id };
  await redis.set(REDIS_KEYS.waOnboard(phone), JSON.stringify(state), { ex: ONBOARD_TTL });

  const waService = getWhatsAppService();
  await waService.sendMessage(phone,
    'Choose your language / בחר שפה / Выберите язык:\n\n1️⃣ English\n2️⃣ עברית\n3️⃣ Русский'
  );
}

/**
 * Check if user is in onboarding flow
 */
export async function isInOnboarding(phone: string): Promise<boolean> {
  const state = await redis.get<string>(REDIS_KEYS.waOnboard(phone));
  return state !== null;
}

/**
 * Handle a message during onboarding
 * Returns true if the message was handled by onboarding, false if it should be routed to normal commands
 */
export async function handleOnboardingMessage(phone: string, text: string): Promise<boolean> {
  const raw = await redis.get<string>(REDIS_KEYS.waOnboard(phone));
  if (!raw) return false;

  let state: OnboardState;
  try {
    state = JSON.parse(raw) as OnboardState;
  } catch {
    await redis.del(REDIS_KEYS.waOnboard(phone));
    return false;
  }

  const waService = getWhatsAppService();

  if (state.step === 'language') {
    const input = text.trim();
    let language: string | null = null;

    if (input === '1' || input.toLowerCase() === 'english' || input.toLowerCase() === 'en') {
      language = 'en';
    } else if (input === '2' || input === 'עברית' || input.toLowerCase() === 'he' || input.toLowerCase() === 'hebrew') {
      language = 'he';
    } else if (input === '3' || input.toLowerCase() === 'русский' || input.toLowerCase() === 'ru' || input.toLowerCase() === 'russian') {
      language = 'ru';
    }

    if (!language) {
      await waService.sendMessage(phone,
        'Reply 1, 2, or 3 / השיבו 1, 2 או 3 / Ответьте 1, 2 или 3:\n\n1️⃣ English\n2️⃣ עברית\n3️⃣ Русский'
      );
      return true;
    }

    // Update user language
    await updateUserById(state.userId, { language } as any);

    // Complete onboarding
    await redis.del(REDIS_KEYS.waOnboard(phone));

    // Send completion message with magic link
    const link = await generateMagicLink(state.userId, language);

    const completionMessages: Record<string, string> = {
      en: 'Language set to English ✓\n\nConnect your Google Calendar and customize settings:',
      he: 'השפה הוגדרה לעברית ✓\n\nחבר את יומן Google שלך והתאם הגדרות:',
      ru: 'Язык установлен: Русский ✓\n\nПодключите Google Календарь и настройте параметры:',
    };

    const buttonLabels: Record<string, string> = {
      en: 'Open Settings',
      he: 'פתח הגדרות',
      ru: 'Открыть настройки',
    };

    await waService.sendMessage(phone, completionMessages[language] || completionMessages.en, {
      whatsappUrlButton: {
        text: buttonLabels[language] || buttonLabels.en,
        url: link,
      },
    });
    return true;
  }

  // Unknown step, clear onboarding
  await redis.del(REDIS_KEYS.waOnboard(phone));
  return false;
}
