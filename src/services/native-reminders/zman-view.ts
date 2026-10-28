// What a card or a reply says about a reminder by zman, in one place (zman reminders by voice plan, Task 7): the rule in
// words, the time it is due at the recipient's place, and where that place is from. Every line that shows a reminder by
// zman (the Telegram card, the WhatsApp card, the created reply, the spoken line, the bulk list) asks `reminderZman` and
// nothing else, so the time a card shows is the one the pass pings at (resolve.ts zmanTimingFor / zmanTimeOn, the one
// due-time code) and the words are the Mini App's (src/lib/calendar-view/zman-words.ts over calendarHome.zmanim.*).
//
// A plain reminder has no view (null): its card and reply are not touched.

import { createTranslator } from 'next-intl';
import type { ParsedEvent, ZmanPause } from '../event-parser';
import { VALID_LOCALES, type Locale } from '../../utils/locale';
import { localDate } from '../../utils/day-events';
import { instantToWallTime } from '../../utils/wall-time';
import type { ZmanOpinion, ZmanSpecValue } from '../../lib/calendar-view/zman-spec';
import { zmanName, zmanRuleWords } from '../../lib/calendar-view/zman-words';
import { zmanKeyOpinion } from '../zmanim/spec';
import { zmanTimeOn, zmanTimingFor, type ReminderCreator } from './resolve';

type WordsT = Parameters<typeof zmanRuleWords>[0];

const translators = new Map<Locale, WordsT>();

/** The Mini App's translator of calendarHome.* for a language (English where the language is not one of ours). */
export async function zmanWordsT(language: string): Promise<WordsT> {
  const locale: Locale = VALID_LOCALES.includes(language as Locale) ? (language as Locale) : 'en';
  let t = translators.get(locale);
  if (!t) {
    const messages = (await import(`../../../messages/${locale}.json`)).default;
    t = createTranslator({ locale, messages, namespace: 'calendarHome' }) as unknown as WordsT;
    translators.set(locale, t);
  }
  return t;
}

/** One opinion of a reminder whose opinion is still to be chosen: a button. */
export interface ZmanChoiceView {
  /** Its place in ParsedEvent.zmanChoices (what a tap sends back). */
  index: number;
  /** The opinion's name as a button says it ("GRA", "Halacha Berura"), or the zman's own name for a key with no opinion. */
  name: string;
  /** The civil day (yyyy-MM-dd, the creator's zone) this choice is created on. */
  day: string;
  /** Its time on that day at the recipient's place, null where there is none. */
  at: Date | null;
  /** `at` as hh:mm (24 hours) in the recipient's zone. */
  time: string | null;
  /** Its time falls inside the recipient's paused Shabbat or Yom Tov: it would not be sent (to one of the two, for a reminder to both: 'one'). */
  paused: ZmanPause | false;
}

/** A reminder by zman as a card or a reply shows it. */
export interface ZmanView {
  /** The rule in words ("10 min before the latest time for Shema (GRA)"); with choices, without the opinion. */
  words: string;
  /** The first occurrence's time, null where there is none (or, with choices, until one is chosen). */
  at: Date | null;
  /** Where the time is counted from: the person's saved place, their zone's main city, or nothing (no clock). */
  source: 'saved' | 'zone' | 'none';
  /** The recipient's zone, which `at` is shown in. */
  zone: string;
  /** The reminder is for the partner alone, at their place. */
  forPartner: boolean;
  /** The reminder is for both: the time is the creator's, each is pinged at their own place. */
  forBoth: boolean;
  /** Present when the opinion is still to be chosen: one per opinion, in the set's order. */
  choices?: ZmanChoiceView[];
}

/** Whether a reminder shows as one by zman: a rule or choices, on a date-only reminder (a clock time given since makes it a fixed time). */
export const showsZman = (event: ParsedEvent): boolean => event.allDay && (!!event.zmanSpec || !!event.zmanChoices?.length);

/** A time as hh:mm in a zone: the zone's own clock, whatever zone the server runs in (wall-time.ts). */
const timeIn = (at: Date, zone: string) => instantToWallTime(at, zone).slice(11, 16);

/**
 * The view of a reminder by zman: its words, the time it is due and where that place is from, or null for a plain
 * reminder. `creator` is whoever made it (the card's user): the partner's own place is read for a reminder for them
 * alone. A reminder by zman asked about without one is a bug, not a plain reminder, so it throws.
 */
export async function reminderZman(
  event: ParsedEvent,
  creator: ReminderCreator | undefined,
  language: string,
  timezone: string
): Promise<ZmanView | null> {
  if (!showsZman(event)) return null;
  if (!creator) throw new Error('A reminder by zman cannot be worded without the person it is made by');
  const t = await zmanWordsT(language);
  const timing = await zmanTimingFor(creator, event, timezone);
  const clock = timing.clock;
  const common = {
    zone: timing.zone,
    source: (clock ? clock.source : 'none') as ZmanView['source'],
    forPartner: event.forUserId != null && !event.forBoth,
    forBoth: event.forUserId != null && event.forBoth === true,
  };

  if (event.zmanSpec) {
    const spec = event.zmanSpec;
    const day = localDate(event.startTime, timezone);
    const opinion: ZmanOpinion | null = 'zman' in spec ? clock?.opinion(spec.zman) ?? zmanKeyOpinion(spec.zman) : null;
    return { ...common, words: zmanRuleWords(t, spec, opinion), at: zmanTimeOn(day, spec, timing, timezone) };
  }

  const choices: ZmanChoiceView[] = (event.zmanChoices ?? []).map((choice, index) => {
    const at = zmanTimeOn(choice.day, choice.spec, timing, timezone);
    const key = 'zman' in choice.spec ? choice.spec.zman : null;
    const opinion = key ? clock?.opinion(key) ?? zmanKeyOpinion(key) : null;
    return {
      index,
      name: key ? (opinion ? t(`zmanim.opinions.${opinion}`) : zmanName(t, key, null)) : zmanRuleWords(t, choice.spec, null),
      day: choice.day,
      at,
      time: at ? timeIn(at, timing.zone) : null,
      paused: choice.paused ?? false,
    };
  });
  // The rule without its opinion: the choices share the zman and the offset
  return { ...common, words: zmanRuleWords(t, event.zmanChoices![0].spec, null), at: null, choices };
}

/** The opinions' names, joined as a language joins alternatives ("GRA or MGA"). */
export function zmanList(names: string[], language: string): string {
  const locale = VALID_LOCALES.includes(language as Locale) ? language : 'en';
  return new Intl.ListFormat(locale, { style: 'long', type: 'disjunction' }).format(names);
}

/**
 * What a zman_not_offered refusal names: the zman's name and the opinions the writer's set has for it ("Latest time
 * for Shema" and "GRA or MGA"), or null where the set has none of that zman. `opinions` runs with `offered`.
 */
export async function offeredWords(
  offered: ZmanSpecValue[],
  opinions: Array<ZmanOpinion | null>,
  language: string
): Promise<{ zman: string; opinions: string } | null> {
  const first = offered[0];
  if (!first || !('zman' in first)) return null;
  const t = await zmanWordsT(language);
  const names = offered.map((spec, i) => {
    const opinion = opinions[i] ?? null;
    return opinion ? t(`zmanim.opinions.${opinion}`) : 'zman' in spec ? zmanName(t, spec.zman, null) : '';
  });
  return { zman: zmanName(t, first.zman, null, false), opinions: zmanList(names, language) };
}
