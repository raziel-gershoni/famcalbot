/**
 * WhatsApp Conversational Onboarding
 * Simple state machine for basic setup (language) via WhatsApp messages.
 * Complex flows (Google OAuth, calendar selection) redirect to web app via magic link.
 */

import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { updateUserById } from './user-service';
import { generateMagicLink } from './magic-link';
import { getWhatsAppService } from './messaging';
import { UserConfig } from '../types';
import { captureError } from '../lib/error-capture';


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
    'Choose your language / בחר שפה / Выберите язык', {
      whatsappButtons: [
        { id: 'lang_en', title: 'English' },
        { id: 'lang_he', title: 'עברית' },
        { id: 'lang_ru', title: 'Русский' },
      ],
    }
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
  } catch (e) {
    captureError(e, 'wa-onboarding', { phone }, 'warning');
    await redis.del(REDIS_KEYS.waOnboard(phone));
    return false;
  }

  const waService = getWhatsAppService();

  if (state.step === 'language') {
    const input = text.trim();
    let language: string | null = null;

    if (input === 'lang_en' || input === '1' || input.toLowerCase() === 'english' || input.toLowerCase() === 'en') {
      language = 'en';
    } else if (input === 'lang_he' || input === '2' || input === 'עברית' || input.toLowerCase() === 'he') {
      language = 'he';
    } else if (input === 'lang_ru' || input === '3' || input.toLowerCase() === 'русский' || input.toLowerCase() === 'ru') {
      language = 'ru';
    }

    if (!language) {
      await waService.sendMessage(phone,
        'Choose your language / בחר שפה / Выберите язык', {
          whatsappButtons: [
            { id: 'lang_en', title: 'English' },
            { id: 'lang_he', title: 'עברית' },
            { id: 'lang_ru', title: 'Русский' },
          ],
        }
      );
      return true;
    }

    // Update user language
    await updateUserById(state.userId, { language } as any);

    // Complete onboarding
    await redis.del(REDIS_KEYS.waOnboard(phone));

    // Send value prop + sample summary, then setup link
    const link = await generateMagicLink(state.userId, language);

    // Load localized onboarding messages from i18n
    const { default: messages } = await import(`@/messages/${language}.json`);
    const t = messages.bot.onboarding;

    // Message 1: Language confirmed + value prop
    await waService.sendMessage(phone, `${t.langConfirm}\n\n${t.valueProp}`);

    // Message 2: Sample summary + CTA with setup link
    await waService.sendMessage(phone, `${t.sampleSummary}\n\n${t.ctaSetup}`, {
      whatsappUrlButton: {
        text: t.ctaButton,
        url: link,
      },
    });
    return true;
  }

  // Unknown step, clear onboarding
  await redis.del(REDIS_KEYS.waOnboard(phone));
  return false;
}
