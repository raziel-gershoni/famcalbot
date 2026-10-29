// An event's date and time as its confirm card shows them: the weekday, the month and the day in the person's language,
// and the start and end as 24-hour times, all in the person's zone. One formatter for the bot's card
// (formatEventDateTime, src/services/voice/confirmations.ts) and the site's picture of it (components/site/HeroDemo.tsx),
// so the picture can never drift from the bot. Pure and client-safe: no import.

/** The card's Intl locale: Hebrew and Russian by their own, anything else American English (the bot's card always has). */
const CARD_LOCALES: Readonly<Record<string, string>> = { he: 'he-IL', ru: 'ru-RU' };

/** "Thursday, November 5" and "16:00 - 17:00" for an event from `start` to `end`, in `language` and `timeZone`. */
export function eventCardWhen(start: Date, end: Date, language: string, timeZone: string): { date: string; time: string } {
  const locale = CARD_LOCALES[language] ?? 'en-US';
  const clock: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone };
  return {
    date: start.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone }),
    time: `${start.toLocaleTimeString(locale, clock)} - ${end.toLocaleTimeString(locale, clock)}`,
  };
}
