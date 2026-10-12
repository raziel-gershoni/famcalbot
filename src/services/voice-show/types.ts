/**
 * Two-host voice show: shapes shared by the writer, the validator and TTS.
 * See docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md.
 */

export type ShowHost = 'A' | 'B';

/** Which summary the show is about. Daily also covers the tomorrow summary. */
export type ShowKind = 'daily' | 'weekly' | 'weather';

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
 * The style string each mood sends in speechMetadata. Kept short on purpose: in the
 * trial, short styles never changed the spoken words (0 of 57 takes) while long
 * director's notes did (4 of 5).
 */
export const MOOD_STYLES: Record<Mood, string> = {
  hype: 'excited sports commentator',
  triumph: 'triumphant, loud and celebratory',
  suspense: 'slow and suspenseful, building tension',
  amused: 'amused, laughing a little',
  surprised: 'surprised, high pitch',
  mock_disappointed: 'mock-disappointed, deflated',
  secret: 'whispering, secretive',
  warm: 'warm and relaxed, slower',
};

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
