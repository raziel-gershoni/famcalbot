/**
 * Which day or days, and which time, a guest message asks about (spec 2026-11-07-ask-in-chat §5.1), and whose time
 * (spec 2026-11-08-ask-in-chat-people §3.1): one call to the model through generateAICompletion (AI_MODEL at its own
 * MEDIUM thinking), answered in JSON and checked here. An answer that breaks the schema or a rule is asked again once
 * with the reason attached (the voice-show writer's pattern); a second one throws AskWindowError. An answer with every
 * field null is `noDate`, not a failure. The model gets no name from FamCal: it says who was asked as a kind, and a
 * person's name as the messages write it (people.ts matches it).
 *
 * A rejection's reason names the field and the rule only, never the value: the model's answer can echo the
 * messages, and the reason reaches the log and the retry prompt.
 */

import type { AICompletionOptions, AICompletionResult } from '../ai-provider';
import { ASK_WINDOW_SCHEMA, buildAskWindowPrompt } from '../../prompts/ask-in-chat';
import { readSpokenHebrewDate, resolveSpokenHebrewDate } from '../hebrew-date-resolve';
import { addDaysToDate, nextDate } from '../../utils/day-events';
import { instantToWallTime } from '../../utils/wall-time';
import type { DayKey } from '../calendar-read/types';
import type { GuestAsk } from './update';

export type CompletionFn = (prompt: string, modelId?: string, options?: AICompletionOptions) => Promise<AICompletionResult>;

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'night';
export const PARTS_OF_DAY: readonly PartOfDay[] = ['morning', 'afternoon', 'evening', 'night'];

/** What a question asks about within each day (ruling 10). */
export type AskRange =
  | { kind: 'day' }
  | { kind: 'part'; part: PartOfDay }
  | { kind: 'at'; time: string }
  | { kind: 'between'; from: string; to: string };

export type AskWindow =
  | { kind: 'window'; days: DayKey[]; range: AskRange; hebrewAsked: boolean }
  | { kind: 'noDate' }
  | { kind: 'tooManyDays' };

/** A group whose time a question asks about (spec 2026-11-08 §3.1). */
export type AskGroup = 'me' | 'partner' | 'kids' | 'family' | 'everyone';
export const ASK_GROUPS: readonly AskGroup[] = ['me', 'partner', 'kids', 'family', 'everyone'];

/** Whose time a question asks about, as the model read it: a group, or one person by the name the messages write. */
export type AskWho = { kind: AskGroup } | { kind: 'person'; name: string };

/** A person's name longer than this is no name. */
export const WHO_NAME_MAX_CHARS = 60;

/** Up to this many days in a row (ruling 10). */
export const MAX_DAYS = 3;
/** A day this far back or ahead of today is "which day?" (ruling 10). */
export const DAYS_BACK = 31;
export const DAYS_AHEAD = 366;

const MAX_ATTEMPTS = 2;

/** The model's answer broke the schema or a rule. The message names a field and a rule, never a value. */
export class AskWindowError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AskWindowError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real 'yyyy-MM-dd' calendar day. */
function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

type Raw = Record<string, unknown>;
const field = (raw: Raw, key: string): unknown => (raw[key] === undefined ? null : raw[key]);

/** The model's answer as a JSON object, or an AskWindowError. */
function readObject(text: string): Raw {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new AskWindowError('the answer is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AskWindowError('the answer is not a JSON object');
  return raw as Raw;
}

/**
 * The model's answer, checked (spec §5.1): `today` is 'yyyy-MM-dd' in the person's zone. Throws AskWindowError for an
 * answer that breaks the schema or a rule; returns noDate for nothing usable, tooManyDays for a run over MAX_DAYS.
 */
export function parseAskWindow(text: string, today: DayKey): AskWindow {
  const r = readObject(text);
  const date = field(r, 'date');
  const lastDate = field(r, 'lastDate');
  const hebrewDate = field(r, 'hebrewDate');
  const time = field(r, 'time');
  const until = field(r, 'until');
  const partOfDay = field(r, 'partOfDay');

  if (date !== null && (typeof date !== 'string' || !isRealDay(date))) throw new AskWindowError('"date" is not a real yyyy-MM-dd day');
  if (lastDate !== null && (typeof lastDate !== 'string' || !isRealDay(lastDate))) throw new AskWindowError('"lastDate" is not a real yyyy-MM-dd day');
  if (date !== null && hebrewDate !== null) throw new AskWindowError('"date" and "hebrewDate" are both set; set one');
  if (time !== null && (typeof time !== 'string' || !TIME.test(time))) throw new AskWindowError('"time" is not HH:mm');
  if (until !== null && (typeof until !== 'string' || !(TIME.test(until) || until === '24:00'))) throw new AskWindowError('"until" is not HH:mm');
  if (partOfDay !== null && !PARTS_OF_DAY.includes(partOfDay as PartOfDay)) throw new AskWindowError('"partOfDay" is not morning, afternoon, evening, night or null');

  let first: DayKey | null = date as string | null;
  const hebrewAsked = hebrewDate !== null;
  if (hebrewAsked) {
    const read = readSpokenHebrewDate(hebrewDate);
    if (!read.date) throw new AskWindowError('"hebrewDate" is not a day from 1 to 30 and a month from the list');
    first = resolveSpokenHebrewDate(read.date, today);
    // That year has no such day (30 Cheshvan in a short year), or none comes within the search: no day to check.
    if (first === null) return { kind: 'noDate' };
  }
  if (first === null) return { kind: 'noDate' };

  const last = (lastDate as string | null) ?? first;
  if (last < first) throw new AskWindowError('"lastDate" is before the first day');
  const days: DayKey[] = [first];
  while (days[days.length - 1] < last) {
    if (days.length === MAX_DAYS) return { kind: 'tooManyDays' };
    days.push(nextDate(days[days.length - 1]));
  }
  if (first < addDaysToDate(today, -DAYS_BACK) || last > addDaysToDate(today, DAYS_AHEAD)) return { kind: 'noDate' };

  let range: AskRange = { kind: 'day' };
  if (typeof time === 'string') {
    // An end that isn't after the start is dropped: the question is the hour from the start.
    range = typeof until === 'string' && until > time ? { kind: 'between', from: time, to: until } : { kind: 'at', time };
  } else if (partOfDay !== null) {
    range = { kind: 'part', part: partOfDay as PartOfDay };
  }
  return { kind: 'window', days, range, hebrewAsked };
}

/**
 * Whose time the model read the question to ask about (spec 2026-11-08 §3.1): null (or missing) is no one in particular.
 * A group drops any name; a person needs a name of 1 to WHO_NAME_MAX_CHARS characters. Throws AskWindowError otherwise,
 * naming the field and never the value.
 */
export function parseAskWho(text: string): AskWho | null {
  const who = field(readObject(text), 'who');
  if (who === null) return null;
  if (typeof who !== 'object' || Array.isArray(who)) throw new AskWindowError('"who" is not an object or null');
  const kind = (who as Raw).kind;
  if (kind === 'person') {
    const name = (who as Raw).name;
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > WHO_NAME_MAX_CHARS) throw new AskWindowError(`"who.name" is not a name of 1 to ${WHO_NAME_MAX_CHARS} characters`);
    return { kind: 'person', name: trimmed };
  }
  if (!ASK_GROUPS.includes(kind as AskGroup)) throw new AskWindowError('"who.kind" is not me, partner, kids, family, everyone or person');
  return { kind: kind as AskGroup };
}

export interface ReadAskWindowOptions {
  tz: string;
  language: 'en' | 'he' | 'ru';
  now: Date;
  /** Defaults to generateAICompletion. Tests inject a fake. */
  complete?: CompletionFn;
}

export interface ReadAskWindowResult {
  window: AskWindow;
  /** Whose time the question asks about; null: no one in particular. */
  who: AskWho | null;
  /** The model's time over every attempt, in ms. */
  aiMs: number;
  attempts: number;
}

/** The prompt's dates: today and the 20 days after it, each with its English weekday (read as the UTC day it names). */
function nextDates(today: DayKey): { day: string; weekday: string }[] {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });
  return Array.from({ length: 21 }, (_, i) => {
    const day = addDaysToDate(today, i);
    return { day, weekday: weekday.format(new Date(`${day}T12:00:00Z`)) };
  });
}

/** One question to the model (and one more after a rejection); throws AskWindowError after two, or the call's own error. */
export async function readAskWindow(ask: GuestAsk, options: ReadAskWindowOptions): Promise<ReadAskWindowResult> {
  // Imported lazily so this file loads without the SDKs (the smokes inject `complete`).
  const complete = options.complete ?? (await import('../ai-provider')).generateAICompletion;
  const wall = instantToWallTime(options.now, options.tz);
  const today = wall.slice(0, 10);
  const prompt = buildAskWindowPrompt({
    today,
    time: wall.slice(11, 16),
    tz: options.tz,
    dates: nextDates(today),
    language: options.language,
    replied: ask.replied ? { text: ask.replied.text, isOurAnswer: ask.replied.isOurAnswer } : null,
    mention: ask.mention,
  });
  let rejection: AskWindowError | null = null;
  let aiMs = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const request = rejection
      ? `${prompt}\n\nYour previous answer was rejected: ${rejection.message}. Answer again with valid JSON that follows every rule above.`
      : prompt;
    const startedAt = Date.now();
    const completion = await complete(request, undefined, { responseJsonSchema: ASK_WINDOW_SCHEMA });
    aiMs += Date.now() - startedAt;
    try {
      return { window: parseAskWindow(completion.text, today), who: parseAskWho(completion.text), aiMs, attempts: attempt };
    } catch (error) {
      if (!(error instanceof AskWindowError)) throw error;
      console.warn(`[ask] window rejected (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}`);
      rejection = error;
    }
  }
  throw rejection!;
}
