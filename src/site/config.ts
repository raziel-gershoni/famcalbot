// The public site's fixed addresses (spec 2026-10-28-public-website §6.2): one place for the site's own URL, which the
// layout, the sitemap, robots, the JSON-LD and the share page read, and for the two start links.
// Client-safe: no import.

/** The site's own origin, with no trailing slash. */
export const SITE_URL = 'https://famcal.bot';

/** The day the public pages' content last changed (yyyy-MM-dd): the sitemap's date for the landing, the blog and the zmanim pages. */
export const SITE_CONTENT_UPDATED = '2026-10-30';

/** The bot on Telegram: the start button opens the chat. */
export const TELEGRAM_BOT_URL = 'https://t.me/family_calendar_telegram_bot';

// The public WhatsApp number of the bot. scripts/smoke-miniapp-gate.ts reads this line as it is written (the gate card's
// fallback number must be this one), so it stays a literal.
const WA_PHONE = '972548524687';

/** The WhatsApp chat with the bot, with the greeting prefilled in the visitor's language (bot.whatsapp.greeting). */
export function whatsappStartUrl(greeting: string): string {
  return `https://wa.me/${WA_PHONE}?text=${encodeURIComponent(greeting)}`;
}
