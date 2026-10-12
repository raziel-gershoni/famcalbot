/**
 * Parses and polices the show writer's JSON before any of it reaches TTS.
 *
 * Hard failures throw ShowScriptError so the writer can regenerate once: bad JSON,
 * a host other than A/B, too few or too many turns, a turn with nothing to say or over
 * the length limit, two speakers merged into one turn, a show where one host never
 * speaks. Everything else is repaired in place and noted in `warnings`: unknown moods
 * become hype, HTML and unlisted tags are stripped, |backchannels| and [cues] removed,
 * sounds over budget dropped.
 */

import { pointHebrewTimes, pointSecondPerson } from './hebrew-pointing';
import {
  MAX_SOUNDS_PER_SHOW, MAX_TURN_CHARS, MAX_TURNS, MIN_TURNS, MOOD_STYLES, MOODS, SOUND_TAGS,
  type Mood, type ShowLine, type ShowScript, type ShowTurn,
} from './types';

export class ShowScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShowScriptError';
  }
}

/**
 * JSON Schema handed to the writer model. Turn-count and length limits are enforced by
 * the parser instead, so the schema only uses keywords every Gemini model accepts.
 */
export const SHOW_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          host: { type: 'string', enum: ['A', 'B'] },
          mood: { type: 'string', enum: [...MOODS] },
          text: { type: 'string' },
        },
        required: ['host', 'mood', 'text'],
      },
    },
  },
  required: ['turns'],
};

const SOUNDS: ReadonlySet<string> = new Set(SOUND_TAGS);
const ANY_TAG = /<\s*(\/?)\s*([A-Za-z][\w-]*)[^<>]*>/g;
const SOUND_TAG = /<([a-z-]+)>/g;
const LEADING_LABEL = /^\s*(?:host\s*)?[AB]\s*[:：]\s*/i;
const INNER_LABEL = /(?:^|[.!?]\s+)(?:host\s*)?[AB]\s*[:：]\s/i;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function parseShowScript(raw: string): ShowScript {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new ShowScriptError('Response is not valid JSON');
  }

  const rawTurns = (data as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(rawTurns)) throw new ShowScriptError('Response has no "turns" array');
  if (rawTurns.length < MIN_TURNS || rawTurns.length > MAX_TURNS) {
    throw new ShowScriptError(`Expected ${MIN_TURNS}-${MAX_TURNS} turns, got ${rawTurns.length}`);
  }

  const warnings: string[] = [];
  const turns = rawTurns.map((value, i) => normalizeTurn(value, i + 1, warnings));
  if (!turns.some(t => t.host === 'A') || !turns.some(t => t.host === 'B')) {
    throw new ShowScriptError('Both hosts must speak');
  }
  enforceSoundBudget(turns, warnings);
  return { turns, warnings };
}

function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(raw);
  return fenced ? fenced[1] : raw.trim();
}

function normalizeTurn(value: unknown, n: number, warnings: string[]): ShowTurn {
  const t = (value ?? {}) as { host?: unknown; mood?: unknown; text?: unknown };
  if (t.host !== 'A' && t.host !== 'B') throw new ShowScriptError(`Turn ${n}: host must be "A" or "B"`);
  if (typeof t.text !== 'string') throw new ShowScriptError(`Turn ${n}: text must be a string`);

  let mood: Mood = 'hype';
  if (typeof t.mood === 'string' && (MOODS as readonly string[]).includes(t.mood)) {
    mood = t.mood as Mood;
  } else {
    warnings.push(`Turn ${n}: unknown mood ${JSON.stringify(t.mood)}, using hype`);
  }

  const text = cleanText(t.text, n, warnings);
  if (!/\p{L}/u.test(text.replace(SOUND_TAG, ''))) throw new ShowScriptError(`Turn ${n}: nothing to say`);
  if (text.length > MAX_TURN_CHARS) {
    throw new ShowScriptError(`Turn ${n}: ${text.length} characters, limit ${MAX_TURN_CHARS}`);
  }
  if (/\d/.test(text)) warnings.push(`Turn ${n}: contains digits (numbers should be words)`);
  return { host: t.host, mood, text };
}

function cleanText(input: string, n: number, warnings: string[]): string {
  let text = input.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, entity: string) => ENTITIES[entity]);

  text = text.replace(LEADING_LABEL, '');
  if (INNER_LABEL.test(text)) {
    throw new ShowScriptError(`Turn ${n}: contains another speaker label; one host per turn`);
  }

  // |wow| backchannels make a phantom second voice in a single-voice request.
  text = text.replace(/\|[^|\n]{0,40}\|/g, m => {
    warnings.push(`Turn ${n}: removed backchannel ${m}`);
    return ' ';
  }).replace(/\|/g, ' ');

  // Keep whitelisted sounds, normalised to <name>. HTML and any other tag go.
  text = text.replace(ANY_TAG, (m, slash: string, name: string) => {
    const tag = name.toLowerCase();
    if (!slash && SOUNDS.has(tag)) return ` <${tag}> `;
    warnings.push(`Turn ${n}: removed tag ${m}`);
    return ' ';
  });

  // [laughs]-style cues would be read aloud.
  text = text.replace(/\[[^\]\n]{0,30}\]/g, m => {
    warnings.push(`Turn ${n}: removed cue ${m}`);
    return ' ';
  });

  text = text.replace(/\p{Extended_Pictographic}️?/gu, '').replace(/[*_#`~]/g, '');
  return text.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}

/** At most MAX_SOUNDS_PER_SHOW sounds, never on consecutive turns. Later ones are dropped. */
function enforceSoundBudget(turns: ShowTurn[], warnings: string[]): void {
  let used = 0;
  let lastTurn = -2;
  turns.forEach((turn, i) => {
    turn.text = turn.text
      .replace(SOUND_TAG, tag => {
        if (used < MAX_SOUNDS_PER_SHOW && (lastTurn === i || lastTurn < i - 1)) {
          used++;
          lastTurn = i;
          return tag;
        }
        warnings.push(`Turn ${i + 1}: dropped ${tag} (sound budget)`);
        return ' ';
      })
      .replace(/\s+/g, ' ')
      .trim();
  });
}

function speakable(text: string, language: string, listenerGender: 'male' | 'female'): string {
  return language === 'he' ? pointSecondPerson(pointHebrewTimes(text), listenerGender) : text;
}

/** Turns as TTS lines: mood becomes its style string; Hebrew words get their niqqud. */
export function toShowLines(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female'): ShowLine[] {
  return turns.map(turn => ({
    host: turn.host,
    text: speakable(turn.text, language, listenerGender),
    style: MOOD_STYLES[turn.mood],
    whisper: turn.mood === 'secret' || turn.text.includes('<whispers>'),
  }));
}

/** The whole show as one paragraph without sounds, for the single-narrator fallback. */
export function scriptToNarration(turns: ShowTurn[], language: string, listenerGender: 'male' | 'female'): string {
  const text = turns.map(t => t.text.replace(SOUND_TAG, ' ').replace(/\s+/g, ' ').trim()).join(' ');
  return speakable(text, language, listenerGender);
}
