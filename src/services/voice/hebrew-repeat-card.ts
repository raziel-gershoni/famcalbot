/**
 * What a confirmation card says about a repeat by the Hebrew date (hebrew-repeats spec §5): the
 * line naming the Hebrew date and the rule, and the notices shown before Confirm.
 *
 * The date is the start's day in the user's zone, in the language's own form (gematriya in
 * Hebrew, the month in the genitive in Russian), through the same helper as the calendar home.
 * The copy is bot.hebrewRepeat in messages/{en,he,ru}.json. Plain text: each card wraps the
 * notices in its own markup.
 */

import { hebrewDayLabel } from '../../lib/calendar-view/hebrew-date';
import { getBotMessage } from '../../lib/bot-messages';
import { localDate } from '../../utils/day-events';
import type { CalendarProviderName } from '../calendar-provider/types';
import type { ParsedEvent } from '../event-parser';
import { isHebrewRepeat, recurrenceNotice } from '../recurrence-fields';

export interface HebrewRepeatCard {
  /** The repeat line ("🔄 Yahrzeit, every year on 10 Tevet"), or null: not a Hebrew repeat, or one Google will not hold. */
  line: string | null;
  /** Notes to show under the card, in plain text. */
  notices: string[];
}

/** The Russian month names in the genitive, as the calendar home reads them ("10 тевета"). */
async function russianMonths(): Promise<string[]> {
  const messages = await import('../../../messages/ru.json');
  return messages.default.calendarHome.hebrewMonthGenitive;
}

/**
 * The card's repeat line and notices for `event` created on `target`.
 * - Not a Hebrew repeat: nothing.
 * - Google: no line, since nothing repeats, and the notice that it is added once.
 * - The built-in calendar: the line, and for a yahrzeit with no year the note that it starts
 *   from the next one.
 */
export async function hebrewRepeatCard(
  event: Pick<ParsedEvent, 'recurrence' | 'startTime'>,
  target: CalendarProviderName,
  language: string,
  timezone: string
): Promise<HebrewRepeatCard> {
  const repeat = event.recurrence;
  if (!isHebrewRepeat(repeat)) return { line: null, notices: [] };

  if (recurrenceNotice(target, repeat)) {
    return { line: null, notices: [await getBotMessage(language, 'hebrewRepeat.notice.google')] };
  }

  const kind = repeat!.hebrewKind ?? 'anniversary';
  const date = hebrewDayLabel(localDate(event.startTime, timezone), language, language === 'ru' ? await russianMonths() : undefined);
  const every = repeat!.interval && repeat!.interval > 1 ? ` x${repeat!.interval}` : '';
  const line = `🔄 ${await getBotMessage(language, `hebrewRepeat.line.${kind}`, { date })}${every}`;
  const notices = repeat!.hebrewNoYear ? [await getBotMessage(language, 'hebrewRepeat.notice.yahrzeitNext')] : [];
  return { line, notices };
}
