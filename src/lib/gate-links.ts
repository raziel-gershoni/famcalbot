/**
 * Where a page with no credential sends someone back: WhatsApp with "settings" prefilled
 * (one tap brings a fresh magic link), or the bot's /start, which sends a fresh dashboard
 * button. Built on the server, where the env is, and passed to the page as props.
 */
export interface GateLinks {
  /** null when WHATSAPP_PHONE_NUMBER is unset */
  whatsapp: string | null;
  telegram: string;
}

const DEFAULT_BOT_USERNAME = 'family_calendar_telegram_bot';

export function gateLinks(): GateLinks {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER;
  return {
    whatsapp: waNumber ? `https://wa.me/${waNumber}?text=settings` : null,
    telegram: `https://t.me/${botUsername}?start=dashboard`,
  };
}
