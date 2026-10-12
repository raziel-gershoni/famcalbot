/**
 * Parses and polices the show writer's JSON before any of it reaches TTS.
 *
 * Hard failures throw ShowScriptError so the writer can regenerate once: bad JSON,
 * a host other than A/B, too few or too many turns, a turn over the length limit, two
 * speakers merged into one turn, a show where one host never speaks. Everything else
 * is repaired in place and noted in `warnings`: unknown moods become hype, HTML and
 * unlisted tags are stripped, |backchannels| and stage-direction cues removed, sounds
 * over budget dropped, and a turn left with no words (a lone <laugh>) is dropped.
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
// Any tag, with a Latin or Hebrew name: <b>, </laugh>, <cheer x="1">, <צחוק>.
const ANY_TAG = /<\s*(\/?)\s*(\p{L}[\p{L}\p{M}\w-]*)[^<>]*>/gu;
const SOUND_TAG = /<([a-z-]+)>/g;
// A whitelisted sound exactly as TTS gets it, or else a stray angle bracket.
const KEPT_SOUND_OR_BRACKET = new RegExp(`<(?:${SOUND_TAGS.join('|')})>|[<>]`, 'g');
// A label may follow leading sounds: "<laugh> A: ..." keeps the laugh, loses the label.
const LEADING_LABEL = /^((?:\s*<[a-z-]+>)*)\s*(?:host\s*)?[AB]\s*[:：]\s*/i;
// '>' is a boundary too, so "... <laugh> B: ..." is caught.
const INNER_LABEL = /(?:^|[.!?]\s+|>\s*)(?:host\s*)?[AB]\s*[:：]\s/i;
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// A keycap (1️⃣) goes whole, digit included. Then pictographs, skin tones, flag letters,
// tag characters, and the joiners and selectors that hold emoji sequences together.
const KEYCAP = /[0-9#*]\uFE0F?\u20E3/g;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu;
// Stage directions written out as words: TTS would read "צוחק" aloud instead of laughing.
const CUE_WORD = /צוחק|צחוק|מצחקק|צחקוק|נאנח|אנחה|לוחש|בלחש|לחישה|מגחך|גיחוך|\b(?:laugh|sigh(?:s|ing|ed)?\b|whisper|chuckl|giggl|gasp|snicker)/i;
const STAR_OR_PAREN_CUE = /\*{1,2}([^*\n]{1,30})\*{1,2}|\(([^()\n]{1,30})\)/g;

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
  const turns = rawTurns
    .map((value, i) => normalizeTurn(value, i + 1, warnings))
    .filter((turn): turn is ShowTurn => turn !== null);
  if (turns.length < MIN_TURNS) {
    throw new ShowScriptError(`Only ${turns.length} turns left after dropping turns with no words; need ${MIN_TURNS}`);
  }
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

/** The turn, cleaned; null for a turn with no words to speak. */
function normalizeTurn(value: unknown, n: number, warnings: string[]): ShowTurn | null {
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
  // A reaction that is only a sound ({B: '<laugh>'}) is not worth a regeneration.
  if (!/\p{L}/u.test(text.replace(SOUND_TAG, ''))) {
    warnings.push(`Turn ${n}: dropped, no words to speak (${JSON.stringify(t.text)})`);
    return null;
  }
  if (text.length > MAX_TURN_CHARS) {
    throw new ShowScriptError(`Turn ${n}: ${text.length} characters, limit ${MAX_TURN_CHARS}`);
  }
  if (/\d/.test(text)) warnings.push(`Turn ${n}: contains digits (numbers should be words)`);
  return { host: t.host, mood, text };
}

/**
 * Every strip comes before the label and tag checks, so nothing they would catch can
 * reappear afterwards: "**B:**" only becomes a label once the asterisks go, "<*cheer*>"
 * only a tag. Gemini reads whatever is left verbatim.
 */
function cleanText(input: string, n: number, warnings: string[]): string {
  let text = input.replace(ENTITY, (_m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()];
    const code = dec ? parseInt(dec, 10) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : ' ';
  });

  text = text.replace(KEYCAP, ' ').replace(EMOJI, ' ');

  // [laughs] goes whatever it says; *...* and (...) only when they hold a cue word, so
  // "*יופי*" and "(בזום)" keep their words. Before the markdown strip, which would
  // otherwise turn "*צוחק*" into the word itself.
  text = text.replace(/\[[^\]\n]{0,30}\]/g, m => {
    warnings.push(`Turn ${n}: removed cue ${m}`);
    return ' ';
  });
  text = text.replace(STAR_OR_PAREN_CUE, (m, starred: string | undefined, paren: string | undefined) => {
    if (!CUE_WORD.test(starred ?? paren ?? '')) return m;
    warnings.push(`Turn ${n}: removed cue ${m}`);
    return ' ';
  });

  text = text.replace(/[*_#`~]/g, '');

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

  text = text.replace(LEADING_LABEL, '$1 ');
  if (INNER_LABEL.test(text)) {
    throw new ShowScriptError(`Turn ${n}: contains another speaker label; one host per turn`);
  }

  // Last guard: only exact sound tags may carry angle brackets.
  text = text.replace(KEPT_SOUND_OR_BRACKET, m => {
    if (m.length > 1) return m;
    warnings.push(`Turn ${n}: removed stray ${m}`);
    return ' ';
  });

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
