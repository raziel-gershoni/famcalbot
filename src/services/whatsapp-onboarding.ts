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
import { captureError } from '../lib/error-capture';

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

    const langConfirm: Record<string, string> = {
      en: 'Language set to English ✓',
      he: 'השפה הוגדרה לעברית ✓',
      ru: 'Язык установлен: Русский ✓',
    };

    const valueProp: Record<string, string> = {
      en: 'Here\'s what you\'ll get:\n\n📅 *Merged family schedule* — yours, spouse, and kids in one view\n🎤 *30-second voice briefing* — listen while making coffee\n🚗 *Kids\' pickup order* — sorted by end time\n🌤️ *Weather tied to your schedule*\n🗣️ *Voice commands* — create events by talking',
      he: 'מה תקבלו:\n\n📅 *לוח זמנים משפחתי מאוחד* — שלכם, בן/בת הזוג והילדים\n🎤 *תקציר קולי של 30 שניות* — לשמוע תוך כדי הקפה\n🚗 *סדר איסוף ילדים* — לפי שעת סיום\n🌤️ *מזג אוויר לפי הלו״ז שלכם*\n🗣️ *פקודות קוליות* — צרו אירועים בדיבור',
      ru: 'Что вы получите:\n\n📅 *Общее расписание семьи* — ваше, супруга и детей\n🎤 *Голосовая сводка за 30 секунд* — слушайте за кофе\n🚗 *Порядок забора детей* — по времени окончания\n🌤️ *Погода привязана к расписанию*\n🗣️ *Голосовые команды* — создавайте события голосом',
    };

    const sampleSummaries: Record<string, string> = {
      en: 'Here\'s what your morning briefing looks like:\n\n━━━━━━━━━━━━━━━\n☀️ *Good morning!*\nToday — Sunday, Mar 15\n\n*Your Schedule:*\n• 09:00 – Team standup (Zoom)\n• 14:00 – Client meeting\n\n*Sarah\'s Schedule:*\n• 10:30 – Dentist\n\n*Kids Pickup:*\n1. 14:00 — Noah (School)\n2. 16:30 — Maya, Liam (Soccer)\n\n💡 Sarah finishes at 12 — she can handle Noah\'s pickup\n🌤️ 22°C, sunny. Light jacket for evening.\n━━━━━━━━━━━━━━━',
      he: 'ככה נראה תקציר הבוקר שלכם:\n\n━━━━━━━━━━━━━━━\n☀️ *בוקר טוב!*\nהיום — יום ראשון, 15.3 (י״ד אדר)\n\n*לוח הזמנים שלך:*\n• 09:00 – ישיבת צוות (זום)\n• 14:00 – פגישה עם לקוח\n\n*של שרה:*\n• 10:30 – רופא שיניים\n\n*סדר איסוף ילדים:*\n1. 14:00 — נועם (גן השלום)\n2. 16:30 — מאיה, ליאם (בית ספר)\n\n💡 שרה מסיימת ב-12 — היא יכולה לאסוף את נועם\n🌤️ 22°C, שמשי. קחו ז\'קט קל לערב.\n━━━━━━━━━━━━━━━',
      ru: 'Вот как выглядит утренняя сводка:\n\n━━━━━━━━━━━━━━━\n☀️ *Доброе утро!*\nСегодня — воскресенье, 15 марта\n\n*Ваше расписание:*\n• 09:00 – Планёрка (Zoom)\n• 14:00 – Встреча с клиентом\n\n*Расписание Ани:*\n• 10:30 – Стоматолог\n\n*Забор детей:*\n1. 14:00 — Даня (садик)\n2. 16:30 — Маша, Лёва (школа)\n\n💡 Аня заканчивает в 12 — она может забрать Даню\n🌤️ 22°C, солнечно. Лёгкая куртка на вечер.\n━━━━━━━━━━━━━━━',
    };

    const ctaMessages: Record<string, string> = {
      en: 'Ready? Connect your Google Calendar to see *your* schedule (60 seconds):',
      he: 'מוכנים? חברו את Google Calendar כדי לראות את *הלו״ז שלכם* (60 שניות):',
      ru: 'Готовы? Подключите Google Calendar, чтобы увидеть *своё* расписание (60 секунд):',
    };

    const buttonLabels: Record<string, string> = {
      en: '🚀 Set Up FamCal',
      he: '🚀 בואו נתחיל',
      ru: '🚀 Настроить FamCal',
    };

    // Message 1: Language confirmed + value prop
    const msg1 = `${langConfirm[language] || langConfirm.en}\n\n${valueProp[language] || valueProp.en}`;
    await waService.sendMessage(phone, msg1);

    // Message 2: Sample summary + CTA with setup link
    const msg2 = `${sampleSummaries[language] || sampleSummaries.en}\n\n${ctaMessages[language] || ctaMessages.en}`;
    await waService.sendMessage(phone, msg2, {
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
