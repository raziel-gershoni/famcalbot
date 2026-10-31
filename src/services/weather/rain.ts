// A day's rain in words, the one source for every surface: the model's prompts (plain), and the person's messages and
// the infographic (in their language and numerals, each time range isolated left to right so a Hebrew line keeps
// 14:00–17:00 in that order). Pure. Plan Task 3.

import type { RainSpell } from '../../types';
import type { BotMessages } from '../../lib/bot-messages';
import { isolateLtr } from '../../lib/bidi-isolate';

type RainDay = { precipitation: number; rainHours: readonly RainSpell[] };

/** Whether the day has rain worth a word: some millimetres, in some hours. */
export function hasRain(day: RainDay): boolean {
  return day.precipitation > 0 && day.rainHours.length > 0;
}

/** The wet stretches for the model: '14:00–17:00 (3 mm), 20:00–24:00 (0.4 mm)'. */
export function rainHoursForModel(spells: readonly RainSpell[]): string {
  return spells.map(s => `${s.start}–${s.end} (${s.mm} mm)`).join(', ');
}

/** A day's rain for the model in a few words: 'no rain', or 'rain 14:00–17:00 (3 mm)'. */
export function rainForModel(day: RainDay): string {
  return hasRain(day) ? `rain ${rainHoursForModel(day.rainHours)}` : 'no rain';
}

/** The wet stretches for a person: '⁦14:00–17:00⁩, ⁦20:00–24:00⁩'. */
export function rainHoursForPerson(spells: readonly RainSpell[]): string {
  return spells.map(s => isolateLtr(`${s.start}–${s.end}`)).join(', ');
}

/** A number in the person's numerals, at most one decimal ('5.1', '5,1' in Russian): every decimal a person reads goes through here. */
export function formatNumber(value: number, language: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

/** Millimetres in the person's numerals, at most one decimal ('3', '0.4', '0,4' in Russian). */
export function formatRainMm(mm: number, language: string): string {
  return formatNumber(mm, language);
}

/**
 * An amount of rain with its unit, the one place the unit is joined: the number, a no-break space (so a line never ends on
 * the number and starts the next with "mm"), and the unit's word in the person's language. '0.4 mm', '0,4 мм'.
 */
export function formatRainAmount(mm: number, t: BotMessages, language: string): string {
  return `${formatRainMm(mm, language)}\u00A0${t.weatherOnly.mm}`;
}

/** A day's rain in one phrase of the person's message: "no rain", or "rain 14:00–17:00, 3 mm". */
export function rainPhrase(day: RainDay, t: BotMessages, language: string): string {
  if (!hasRain(day)) return t.weatherOnly.noRain;
  return t.weatherOnly.rainPhrase.replace('{hours}', rainHoursForPerson(day.rainHours)).replace('{mm}', formatRainAmount(day.precipitation, t, language));
}
