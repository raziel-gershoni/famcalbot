/**
 * The line a morning or evening briefing carries as a browser notification (web push spec §2.2, §3.5): the day's items
 * as "Dentist 09:00, Pickup 16:00 and 2 more". It is built from the day the summary already reads (readSummaryEvents in
 * telegram/summary.ts), with no model call and nothing counted against the plan. All-day items come first, then the
 * timed ones by start; the first three are named and the rest are a count. Times are the person's own clock, 24 hours.
 *
 * No log line here holds a title: the callers log counts.
 */

import { createTranslator } from 'next-intl';
import type { CalendarEvent } from '../../types';
import { getBotMessages } from '../../lib/bot-messages';
import { instantToWallTime } from '../../utils/wall-time';
import { normalizeLocale } from '../../utils/locale';

/** How many items the line names; the rest are "and N more". */
export const BRIEFING_NAMES_SHOWN = 3;
/** A name longer than this is cut with an ellipsis, so three names and their times stay a line. */
export const BRIEFING_NAME_MAX_CHARS = 40;

export interface BriefingItem {
  name: string;
  /** 'HH:mm' on the person's clock; null for an item with no time on this day. */
  time: string | null;
}

/** One line of text: newlines and runs of spaces become one space, and a long name is cut on whole characters. */
function shortName(summary: string | undefined): string {
  const name = (summary ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(name);
  return chars.length > BRIEFING_NAME_MAX_CHARS ? `${chars.slice(0, BRIEFING_NAME_MAX_CHARS - 1).join('').trimEnd()}…` : name;
}

/**
 * The day's items in the order the line names them: those with no time on this day first (an all-day event, one that
 * started before the day, a reminder with only a date), then the timed ones by start, ties in the order given. A
 * carried-over open reminder (reminder.openSince) belongs to an earlier day and is not listed; an item with no name is not
 * listed. A reminder by zman is timed by its zman (reminder.zmanAt, which shapeDayReminders sets).
 */
export function briefingItems(events: CalendarEvent[], timezone: string): BriefingItem[] {
  const untimed: BriefingItem[] = [];
  const timed: Array<BriefingItem & { at: number }> = [];
  for (const event of events) {
    if (event.reminder?.openSince) continue;
    const name = shortName(event.summary);
    if (!name) continue;
    const startedBefore = event.daySpan === 'continues' || event.daySpan === 'spansDay';
    const instant = startedBefore ? undefined : event.start?.includes('T') ? event.start : event.reminder?.zmanAt;
    const at = instant ? new Date(instant) : null;
    if (!at || Number.isNaN(at.getTime())) {
      untimed.push({ name, time: null });
      continue;
    }
    timed.push({ name, time: instantToWallTime(at, timezone).slice(11, 16), at: at.getTime() });
  }
  timed.sort((a, b) => a.at - b.at);
  return [...untimed, ...timed.map(({ name, time }) => ({ name, time }))];
}

/**
 * The notification's text for a day, or null when nothing is on it (the caller sends nothing). `items` is how many the day
 * has, for the caller's log line.
 */
export async function buildBriefingBody(events: CalendarEvent[], timezone: string, language: string | null | undefined): Promise<{ body: string; items: number } | null> {
  const items = briefingItems(events, timezone);
  if (items.length === 0) return null;
  const named = items.slice(0, BRIEFING_NAMES_SHOWN).map((item) => (item.time ? `${item.name} ${item.time}` : item.name));
  const more = items.length - named.length;
  if (more <= 0) return { body: named.join(', '), items: items.length };
  // "and 2 more" takes its language's plural form (ICU, through next-intl's translator, as zman-view.ts does)
  const locale = normalizeLocale(language);
  const bot = await getBotMessages(locale);
  const t = createTranslator({ locale, messages: { push: bot.push }, namespace: 'push' });
  return { body: `${named.join(', ')} ${t('briefingMore', { count: more })}`, items: items.length };
}
