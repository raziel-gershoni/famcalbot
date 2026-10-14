/**
 * Time-of-day greetings in the three supported languages.
 *
 * "Good night" is a farewell in all three, so the small hours get a neutral hello
 * instead: before NIGHT_END_HOUR it is still night, not morning.
 */

/** Hours before this (0-4) count as night. */
export const NIGHT_END_HOUR = 5;

const GREETINGS: Record<string, { night: string; morning: string; afternoon: string; evening: string }> = {
  he: { night: 'שלום', morning: 'בוקר טוב', afternoon: 'צהריים טובים', evening: 'ערב טוב' },
  en: { night: 'Hello', morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' },
  ru: { night: 'Здравствуйте', morning: 'Доброе утро', afternoon: 'Добрый день', evening: 'Добрый вечер' },
};

/**
 * Greeting for a local hour (0-23): night < 5, morning < 12, afternoon < 18, evening
 * otherwise. No trailing punctuation. An unknown language falls back to English.
 */
export function timeOfDayGreeting(hour: number, language: string = 'en'): string {
  const greetings = GREETINGS[language] || GREETINGS.en;
  if (hour < NIGHT_END_HOUR) return greetings.night;
  if (hour < 12) return greetings.morning;
  if (hour < 18) return greetings.afternoon;
  return greetings.evening;
}
