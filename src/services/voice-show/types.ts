/**
 * Two-host voice show: shapes shared by the writer, the validator and TTS.
 * See docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md.
 */

export type ShowHost = 'A' | 'B';

/**
 * Which summary the show is about. Tomorrow is its own kind so the writer knows the day
 * from code: given only the summary's own "מחר" label, it still opened with "good
 * morning, today is..." in every eval run.
 */
export type ShowKind = 'daily' | 'tomorrow' | 'weekly' | 'weather';

export const MOODS = [
  'hype',
  'triumph',
  'suspense',
  'amused',
  'surprised',
  'mock_disappointed',
  'secret',
  'warm',
] as const;

export type Mood = (typeof MOODS)[number];

/**
 * The hosts' persona, on every line. Built-in voices start calmer than an excited
 * commentator, so it asks for high energy; picked by ear on 2026-10-12 from four
 * built-in pairs in two styles.
 */
export const HOST_STYLE = 'high-energy, excited sports commentator';

/**
 * The style string each mood sends in speechMetadata. Every mood keeps the hosts'
 * sports-commentator persona and only adds a colour, so each host stays one person at
 * one pace. Mood styles of their own ("slow and suspenseful", "warm and relaxed,
 * slower") dropped a host's pitch by about nine semitones and slowed suspense by 30%,
 * and the owner heard the two hosts as four people. With the persona kept, every
 * colour below measured within 8% of the base pace and 3 semitones of its pitch.
 * "Confidential" and "conspiratorial" still dropped six to seven semitones, so secret
 * leans in instead. Kept short on purpose: short styles never changed the spoken words
 * (0 of 57 takes) while long director's notes did (4 of 5).
 */
const MOOD_COLOURS: Record<Mood, string> = {
  hype: '',
  triumph: 'celebrating',
  suspense: 'teasing',
  amused: 'amused',
  surprised: 'surprised',
  mock_disappointed: 'playfully disappointed',
  secret: 'leaning in close',
  warm: 'warm',
};

/** A mood's style string: the hosts' persona plus the mood's colour. */
export function moodStyle(mood: Mood): string {
  return MOOD_COLOURS[mood] ? `${HOST_STYLE}, ${MOOD_COLOURS[mood]}` : HOST_STYLE;
}

export const MOOD_STYLES = Object.fromEntries(MOODS.map(mood => [mood, moodStyle(mood)])) as Record<Mood, string>;

/**
 * Inline sounds the hosts may use. Each was heard by a blind listener on both hosts in
 * sports style. Giggle and snicker collapse into a laugh, groan and phew into a sigh,
 * and cheer, shout, tsk and pff did nothing, so they are not offered.
 */
export const SOUND_TAGS = ['chuckle', 'laugh', 'sigh', 'gasp', 'whispers', 'throat-clearing'] as const;

export const MAX_SOUNDS_PER_SHOW = 2;
export const MIN_TURNS = 4;
export const MAX_TURNS = 30;
export const MAX_TURN_CHARS = 400;

export interface ShowTurn {
  host: ShowHost;
  mood: Mood;
  /** Words to speak, possibly with whitelisted <sound> tags. No HTML, no labels. */
  text: string;
}

export interface ShowScript {
  turns: ShowTurn[];
  /** What the validator repaired silently (stripped tags, unknown moods). For logs. */
  warnings: string[];
}

/** One line as TTS receives it. Also the wire format of tts-service's /api/dialogue. */
export interface ShowLine {
  host: ShowHost;
  text: string;
  style?: string;
  /** Whispered lines keep their level below the host's normal voice when mixed. */
  whisper?: boolean;
}

/** A voice note ready to send. */
export interface ProducedVoice {
  filePath: string;
  /** Admin-only metrics caption, Telegram HTML. */
  caption?: string;
  /** For analytics. */
  durationSeconds: number;
}
