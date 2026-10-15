/**
 * Where a page with no credential sends someone back: WhatsApp with "settings" prefilled
 * (one tap brings a fresh magic link), or the bot's /start, which sends a fresh dashboard
 * button. Built on the server, where the env is, and passed to the page as props.
 */
export interface GateLinks {
  whatsapp: string;
  telegram: string;
}

// The fallbacks for an unset TELEGRAM_BOT_USERNAME / WHATSAPP_PHONE_NUMBER, also used by
// the Google-connect finish flow, where a missing link would leave no way to finish.
export const DEFAULT_BOT_USERNAME = 'family_calendar_telegram_bot';
// The public number the landing, how-it-works and share pages link to. Without a WhatsApp
// line the card's only action is the Telegram one, which splits a WhatsApp-only account.
export const DEFAULT_WA_NUMBER = '972548524687';

export function gateLinks(): GateLinks {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER || DEFAULT_WA_NUMBER;
  return {
    whatsapp: `https://wa.me/${waNumber}?text=settings`,
    telegram: `https://t.me/${botUsername}?start=dashboard`,
  };
}
