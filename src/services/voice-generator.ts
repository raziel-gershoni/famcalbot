/**
 * Voice Generation Service
 * Generates speech from text using Gemini TTS, always on TTS_MODEL; the request shape
 * lives in ./gemini-tts.
 *
 * Two products:
 * - generateVoiceMessage: one voice reads one text: the spoken CRUD outcome, and the
 *   narrator for a language without show hosts. It speaks in the language's anchor.
 * - generateShowVoice: the two-host show. One TTS request per line, mixed into one
 *   voice note. See docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md.
 *   The calm single voice (format 'calm', docs/superpowers/specs/2026-11-07-calm-voice-design.md) goes the same
 *   way with a cast of one: CALM_VOICES, CALM_STYLE on every paragraph, a longer gap between them.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { encodePcmToOggOpus, SAMPLE_RATE } from '../utils/pcm-to-ogg-opus';
import { mixDialogue } from '../utils/pcm-mix';
import { createSemaphore } from '../utils/semaphore';
import { TTS_MODEL } from '../config/tts-models';
import {
  synthesizeSpeech, type SpeechAudio, type SynthesizeSpeechInput,
} from './gemini-tts';
import { synthesizeDialogue } from './dialogue-tts';
import type { ShowFormat, ShowLine } from './voice-show/types';

/** The two show hosts' voices for a language: Gemini built-in voices, by name. */
export interface ShowVoices {
  /** The anchor. Also the voice of every single-voice message: replies and the narrator. */
  A: string;
  /** The co-host. */
  B: string;
}

// Built-in voices only, so they work with any Gemini key. All picked by the owner's ear
// on 2026-10-12 with the high-energy HOST_STYLE: Hebrew from four built-in pairs,
// English and Russian from finalists of a blind round-robin of all 16 male built-in
// voices. A language without an entry has no show and gets the English anchor.
const SHOW_VOICES: Record<string, ShowVoices> = {
  he: { A: 'Schedar', B: 'Puck' },
  en: { A: 'Rasalgethi', B: 'Sadachbia' },
  ru: { A: 'Schedar', B: 'Puck' },
};

/** Host voices for a language, or null when the language has no show yet. */
export function getShowVoices(language: string): ShowVoices | null {
  return Object.hasOwn(SHOW_VOICES, language) ? SHOW_VOICES[language] : null;
}

/** The calm single voice for a language: one Gemini built-in voice, and its gender (how the presenter speaks of themself). */
export interface CalmVoice {
  voice: string;
  gender: 'male' | 'female';
}

// Built-in voices only, male in every language: the owner's blind picks of 2026-11-07 (spec §4: Umbriel, Achird,
// Iapetus and Charon, each heard with CALM_STYLE and CALM_GAP_MS). Nothing else names a calm voice. Never Schedar or
// Puck: the show's hosts would make calm sound like the show. A new voice here means a new listening round.
export const CALM_VOICES: Readonly<Record<string, CalmVoice>> = {
  he: { voice: 'Iapetus', gender: 'male' },
  en: { voice: 'Charon', gender: 'male' },
  ru: { voice: 'Iapetus', gender: 'male' },
};

/** The calm voice for a language, or null when it has none. */
export function getCalmVoice(language: string): CalmVoice | null {
  return Object.hasOwn(CALM_VOICES, language) ? CALM_VOICES[language] : null;
}

/** Who speaks a voice note: the show's two hosts, or calm's one presenter (A only). */
export interface ShowCast {
  A: string;
  B?: string;
}

/** Silence between calm paragraphs, as the owner heard them in the listening round; the show keeps the mixer's default 200 ms. */
const CALM_GAP_MS = 400;

function voiceFor(cast: ShowCast, host: ShowLine['host']): string {
  const voice = cast[host];
  if (!voice) throw new Error(`[TTS] No voice for host ${host} in this cast`);
  return voice;
}

/** The single voice for a language: its anchor, so replies sound like the show. */
function narratorVoice(language: string): string {
  return (getShowVoices(language) ?? getShowVoices('en') ?? SHOW_VOICES.he).A;
}

// Retry configuration
const TTS_MAX_RETRIES = 1;
const TTS_BASE_DELAY_MS = 500;

/**
 * Retry wrapper for transient TTS errors (503/429).
 * No artificial timeout — relies on SDK-level timeouts.
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error as { status?: number };
      const isRetryable = err.status === 503 || err.status === 429;
      if (attempt === maxRetries || !isRetryable) throw error;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw new Error('Unreachable');
}

export interface VoiceGenerationResult {
  filePath: string;
  ttsMs: number;
  ttsModel: string;
  voiceName: string;
}

export interface VoiceMessageOptions {
  /** A built-in voice name. Defaults to the language's anchor. */
  voiceName?: string;
}

/** Writes an OGG voice note to /tmp and returns its path. */
async function writeVoiceFile(oggBuffer: Buffer): Promise<string> {
  const randomId = randomBytes(4).toString('hex');
  const filePath = path.join('/tmp', `voice-${Date.now()}-${randomId}.opus`);
  await fs.writeFile(filePath, oggBuffer);
  return filePath;
}

/**
 * Generate a voice message from plain text with one narrator.
 * @param condensedText - Plain text already condensed by LLM
 * @param language - Language code (e.g., 'he', 'en', 'ru')
 * @param options - voiceName overrides the language's narrator voice
 * @returns Path to generated OGG OPUS audio file in /tmp
 */
export async function generateVoiceMessage(
  condensedText: string,
  language: string = 'en',
  options: VoiceMessageOptions = {},
): Promise<VoiceGenerationResult> {
  const voiceName = options.voiceName || narratorVoice(language);
  const model = TTS_MODEL;

  const startTime = Date.now();

  console.log('[TTS] Generating voice message (Gemini TTS):', {
    textLength: condensedText.length,
    language,
    voice: voiceName,
    model,
  });

  const audio = await callWithRetry(
    () => synthesizeSpeech({
      apiKey: process.env.GEMINI_API_KEY || '',
      model,
      text: condensedText,
      voiceName,
    }),
    TTS_MAX_RETRIES,
    TTS_BASE_DELAY_MS,
  );

  // The Opus encoder is fixed at 24 kHz. Audio at any other rate would play at the
  // wrong speed and pitch with no error, so refuse it instead.
  if (audio.sampleRate !== SAMPLE_RATE) {
    throw new Error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; the encoder needs ${SAMPLE_RATE} Hz`);
  }

  const pcmBuffer = audio.pcm;
  console.log(`[TTS] Received ${pcmBuffer.length} bytes of PCM audio (MIME: ${audio.mimeType || 'unspecified'})`);

  // Convert PCM to OGG OPUS — encoder handles frame truncation internally
  const oggBuffer = encodePcmToOggOpus(pcmBuffer);
  const filePath = await writeVoiceFile(oggBuffer);

  const elapsed = Date.now() - startTime;
  console.log('[TTS] Voice generated successfully:', {
    filePath,
    pcmKB: (pcmBuffer.length / 1024).toFixed(2),
    oggKB: (oggBuffer.length / 1024).toFixed(2),
    durationMs: elapsed,
  });

  return { filePath, ttsMs: elapsed, ttsModel: model, voiceName };
}

export interface ShowVoiceResult {
  filePath: string;
  ttsMs: number;
  ttsModel: string;
  voices: ShowCast;
  /** Which voice note this was: the show or the calm single voice. */
  format: ShowFormat;
  lineCount: number;
  audioSeconds: number;
  /** Output audio tokens across all lines; 0 when not reported. */
  audioTokens: number;
}

/** Test seams: the Gemini call, and the show's time budget. */
export interface ShowVoiceDeps {
  synthesize?: (input: SynthesizeSpeechInput) => Promise<SpeechAudio>;
  /** Defaults to SHOW_DEADLINE_MS. */
  deadlineMs?: number;
}

// The hourly summary run can start many shows at once, and each show already sends up
// to SHOW_LINE_CONCURRENCY requests. Capping shows per process keeps the burst near
// the 24 requests in flight that ran clean in the trial.
const MAX_CONCURRENT_SHOWS = 3;
const SHOW_LINE_CONCURRENCY = 8;
const withShowSlot = createSemaphore(MAX_CONCURRENT_SHOWS);

// One budget per show, from the moment it gets a slot. Without it a slow Gemini kept
// one of the three slots for minutes while other users queued.
const SHOW_DEADLINE_MS = 90_000;

/**
 * Generate the two-host show, or the calm single voice, from validated lines.
 * @param lines - From voice-show/script toShowLines(): host, text, style, whisper
 * @param language - Must have hosts (getShowVoices), or for calm a calm voice (getCalmVoice)
 * @param format - 'calm' speaks every line in the language's calm voice; the show is the default
 * @returns Path to the OGG OPUS file in /tmp, with metrics for the admin caption
 */
export async function generateShowVoice(
  lines: ShowLine[],
  language: string,
  deps: ShowVoiceDeps = {},
  format: ShowFormat = 'show',
): Promise<ShowVoiceResult> {
  let voices: ShowCast | null;
  if (format === 'calm') {
    const calm = getCalmVoice(language);
    if (!calm) throw new Error(`[TTS] No calm voice for language "${language}"`);
    voices = { A: calm.voice };
  } else {
    voices = getShowVoices(language);
    if (!voices) throw new Error(`[TTS] No show hosts for language "${language}"`);
  }
  if (!lines.length) throw new Error('[TTS] Show has no lines');

  const cast = voices;
  const model = TTS_MODEL;
  const queuedAt = Date.now();

  return withShowSlot(async () => {
    const deadline = Date.now() + (deps.deadlineMs ?? SHOW_DEADLINE_MS);
    console.log('[TTS] Show got a slot:', { waitedMs: Date.now() - queuedAt, lines: lines.length, format });
    // Only the time left: synthesizeDialogue fails fast when too little remains.
    return generateShowLocal(lines, cast, model, deps, deadline, format);
  });
}

async function generateShowLocal(
  lines: ShowLine[],
  voices: ShowCast,
  model: string,
  deps: ShowVoiceDeps,
  deadline: number,
  format: ShowFormat,
): Promise<ShowVoiceResult> {
  const startTime = Date.now();
  console.log('[TTS] Generating show locally:', { lines: lines.length, model, voices, msLeft: deadline - startTime });

  const audio = await synthesizeDialogue({
    apiKey: process.env.GEMINI_API_KEY || '',
    model,
    lines: lines.map(line => ({ voice: voiceFor(voices, line.host), text: line.text, style: line.style })),
    synthesize: deps.synthesize ?? synthesizeSpeech,
    concurrency: SHOW_LINE_CONCURRENCY,
    deadline,
  });

  // The Opus encoder is fixed at 24 kHz; anything else would play at the wrong speed.
  if (audio.sampleRate !== SAMPLE_RATE) {
    throw new Error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; the encoder needs ${SAMPLE_RATE} Hz`);
  }

  const pcm = mixDialogue(
    audio.pcms.map((p, i) => ({ pcm: p, speaker: lines[i].host, keepDynamics: lines[i].whisper })),
    format === 'calm' ? { sampleRate: SAMPLE_RATE, gapMs: CALM_GAP_MS } : { sampleRate: SAMPLE_RATE },
  );
  const oggBuffer = encodePcmToOggOpus(pcm);
  const filePath = await writeVoiceFile(oggBuffer);

  const result: ShowVoiceResult = {
    filePath,
    ttsMs: Date.now() - startTime,
    ttsModel: model,
    voices,
    format,
    lineCount: lines.length,
    audioSeconds: pcm.length / 2 / SAMPLE_RATE,
    audioTokens: audio.audioTokens,
  };
  console.log('[TTS] Local show completed:', {
    ...result,
    requests: audio.requests,
    retries: audio.requests - lines.length,
    oggKB: (oggBuffer.length / 1024).toFixed(2),
  });
  return result;
}

/**
 * Clean up temporary voice file
 */
export async function cleanupVoiceFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
    console.log('[TTS] Voice file cleaned up:', filePath);
  } catch (error) {
    console.warn('[TTS] Failed to cleanup voice file:', filePath, error);
  }
}
