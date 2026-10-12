/**
 * Voice Generation Service
 * Generates speech from text using Gemini TTS. The model is chosen per request - see
 * resolveTtsModel() - and the request shape per model lives in ./gemini-tts.
 *
 * Two products:
 * - generateVoiceMessage: one narrator reads one text. Languages without show hosts,
 *   the show's fallback when a host voice is missing, and the spoken CRUD outcome.
 * - generateShowVoice: the two-host show. One TTS request per line, mixed into one
 *   voice note. See docs/superpowers/specs/2026-10-12-two-host-voice-show-design.md.
 *
 * Both run on the Vercel tts-service when TTS_SERVICE_URL is set and fall back to
 * local synthesis on any failure there.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { encodePcmToOggOpus, SAMPLE_RATE } from '../utils/pcm-to-ogg-opus';
import { mixDialogue } from '../utils/pcm-mix';
import { createSemaphore } from '../utils/semaphore';
import { DEFAULT_TTS_MODEL, getTtsModelConfig } from '../config/tts-models';
import {
  isDesignedVoice, modelForDesignedVoices, synthesizeSpeech, type SpeechAudio, type SynthesizeSpeechInput,
} from './gemini-tts';
import { synthesizeDialogue } from './dialogue-tts';
import { getTtsModelSetting } from './reminder-cache';
import type { ShowLine } from './voice-show/types';

/**
 * Which TTS model to use: the admin panel setting, then the GEMINI_TTS_MODEL env var,
 * then the code default. Resolved per request, not at import, so a change in the admin
 * panel takes effect on the next voice message without a redeploy.
 */
export async function resolveTtsModel(): Promise<string> {
  const fromAdmin = await getTtsModelSetting();
  // The admin route validates on write; re-check here so a stale or hand-edited row
  // can't route every voice message to a model id that doesn't exist.
  if (fromAdmin && getTtsModelConfig(fromAdmin)) return fromAdmin;
  return process.env.GEMINI_TTS_MODEL || DEFAULT_TTS_MODEL;
}

// Narrator voice per language (with env var overrides)
// All male voices, matching previous Google TTS Wavenet-D male voices
const VOICE_CONFIG: Record<string, string> = {
  he: process.env.GEMINI_TTS_VOICE_HE || 'Algieba',   // Smooth male — Hebrew
  en: process.env.GEMINI_TTS_VOICE_EN || 'Achird',     // Friendly male — English
  ru: process.env.GEMINI_TTS_VOICE_RU || 'Schedar',    // Even male — Russian
};

/** The two show hosts' voices for a language: designed voices stored in the Gemini project. */
export interface ShowVoices {
  A: string;
  B: string;
}

// Hebrew hosts chosen by ear in the 2026-10 trial. A language without an entry keeps
// the narrator. The env overrides allow a swap without a code change.
const SHOW_VOICES: Record<string, ShowVoices> = {
  he: {
    A: process.env.GEMINI_SHOW_VOICE_HE_A || 'voice_33yuo333h4y2', // warm, late 30s
    B: process.env.GEMINI_SHOW_VOICE_HE_B || 'voice_zrrafp34tgt8', // young, energetic, 20s
  },
};

/** Host voices for a language, or null when the language has no show yet. */
export function getShowVoices(language: string): ShowVoices | null {
  return Object.hasOwn(SHOW_VOICES, language) ? SHOW_VOICES[language] : null;
}

// Retry configuration
const TTS_MAX_RETRIES = 1;
const TTS_BASE_DELAY_MS = 500;

/**
 * Retry wrapper for transient TTS errors (503/429).
 * No artificial timeout — relies on SDK-level timeouts and Vercel's maxDuration.
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

// Language names for TTS prompt
const LANGUAGE_NAMES: Record<string, string> = {
  he: 'Hebrew',
  en: 'English',
  ru: 'Russian',
};

export interface VoiceGenerationResult {
  filePath: string;
  ttsMs: number;
  ttsModel: string;
  voiceName: string;
}

export interface VoiceMessageOptions {
  /** A prebuilt voice name or a designed voice id. Defaults to the language's narrator. */
  voiceName?: string;
}

// Remote TTS timeout (30s — generous but below Vercel's 60s maxDuration)
const REMOTE_TTS_TIMEOUT_MS = 30_000;

/** Writes an OGG voice note to /tmp and returns its path. */
async function writeVoiceFile(oggBuffer: Buffer): Promise<string> {
  const randomId = randomBytes(4).toString('hex');
  const filePath = path.join('/tmp', `voice-${Date.now()}-${randomId}.opus`);
  await fs.writeFile(filePath, oggBuffer);
  return filePath;
}

/**
 * Generate voice via remote serverless TTS function.
 * Returns OGG OPUS binary written to /tmp.
 */
async function generateVoiceRemote(
  text: string,
  language: string,
  voiceName: string,
  model: string,
): Promise<VoiceGenerationResult> {
  const startTime = Date.now();
  const url = `${process.env.TTS_SERVICE_URL}/api/tts`;

  console.log('[TTS] Calling remote TTS service:', {
    url,
    textLength: text.length,
    language,
    voice: voiceName,
    model,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_TTS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TTS_API_KEY}`,
      },
      // The model travels with the request so the admin panel setting applies on the
      // remote path too. A tts-service deployed before model selection existed ignores
      // it and uses its own GEMINI_TTS_MODEL.
      body: JSON.stringify({ text, language, voiceName, model }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Remote TTS returned ${response.status}: ${body}`);
    }

    const oggBuffer = Buffer.from(await response.arrayBuffer());
    const remoteDurationMs = response.headers.get('X-TTS-Duration-Ms');
    // The model that actually spoke. A tts-service deployed before model selection
    // existed sends no header and uses its own GEMINI_TTS_MODEL, so the requested
    // model is only a best guess in that case - log both so it's visible.
    const remoteModel = response.headers.get('X-TTS-Model');

    const filePath = await writeVoiceFile(oggBuffer);

    const elapsed = Date.now() - startTime;
    console.log('[TTS] Remote TTS completed:', {
      filePath,
      oggKB: (oggBuffer.length / 1024).toFixed(2),
      remoteDurationMs,
      requestedModel: model,
      remoteModel: remoteModel ?? '(not reported - tts-service predates model selection)',
      totalMs: elapsed,
    });

    return { filePath, ttsMs: elapsed, ttsModel: remoteModel ?? model, voiceName };
  } finally {
    clearTimeout(timeout);
  }
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
  const voiceName = options.voiceName || VOICE_CONFIG[language] || VOICE_CONFIG['en'] || 'Achird';

  const configuredModel = await resolveTtsModel();
  // Legacy models cannot speak designed voices.
  const model = isDesignedVoice(voiceName) ? modelForDesignedVoices(configuredModel) : configuredModel;

  // If TTS_SERVICE_URL is set, offload to remote serverless function
  if (process.env.TTS_SERVICE_URL) {
    try {
      return await generateVoiceRemote(condensedText, language, voiceName, model);
    } catch (error) {
      console.warn('[TTS] Remote TTS failed, falling back to local:', error);
    }
  }

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
      languageName: LANGUAGE_NAMES[language] || 'English',
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
  voices: ShowVoices;
  lineCount: number;
  audioSeconds: number;
  /** Output audio tokens across all lines; 0 when not reported. */
  audioTokens: number;
  via: 'remote' | 'local';
}

/** Test seam: replaces the Gemini call on the local path. */
export interface ShowVoiceDeps {
  synthesize?: (input: SynthesizeSpeechInput) => Promise<SpeechAudio>;
}

// The hourly summary run can start many shows at once, and each show already sends up
// to SHOW_LINE_CONCURRENCY requests. Capping shows per process keeps the burst near
// the 24 requests in flight that ran clean in the trial.
const MAX_CONCURRENT_SHOWS = 3;
const SHOW_LINE_CONCURRENCY = 8;
const withShowSlot = createSemaphore(MAX_CONCURRENT_SHOWS);

// Below Vercel's 60s maxDuration, and longer than the narrator's 30s because a show is
// many requests.
const REMOTE_SHOW_TIMEOUT_MS = 55_000;

/**
 * Generate the two-host show from validated lines.
 * @param lines - From voice-show/script toShowLines(): host, text, style, whisper
 * @param language - Must have hosts (getShowVoices)
 * @returns Path to the OGG OPUS file in /tmp, with metrics for the admin caption
 */
export async function generateShowVoice(
  lines: ShowLine[],
  language: string,
  deps: ShowVoiceDeps = {},
): Promise<ShowVoiceResult> {
  const voices = getShowVoices(language);
  if (!voices) throw new Error(`[TTS] No show hosts for language "${language}"`);
  if (!lines.length) throw new Error('[TTS] Show has no lines');

  const model = modelForDesignedVoices(await resolveTtsModel());

  return withShowSlot(async () => {
    if (process.env.TTS_SERVICE_URL) {
      try {
        return await generateShowRemote(lines, language, voices, model);
      } catch (error) {
        console.warn('[TTS] Remote show failed, falling back to local:', error);
      }
    }
    return generateShowLocal(lines, voices, model, deps);
  });
}

async function generateShowRemote(
  lines: ShowLine[],
  language: string,
  voices: ShowVoices,
  model: string,
): Promise<ShowVoiceResult> {
  const startTime = Date.now();
  const url = `${process.env.TTS_SERVICE_URL}/api/dialogue`;
  console.log('[TTS] Calling remote show service:', { url, lines: lines.length, language, model });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TTS_API_KEY}`,
    },
    body: JSON.stringify({ language, model, voices, lines }),
    // Also bounds reading the body below.
    signal: AbortSignal.timeout(REMOTE_SHOW_TIMEOUT_MS),
  });

  if (!response.ok) {
    // A 404 means the deployed tts-service predates /api/dialogue.
    const body = await response.text().catch(() => '');
    throw new Error(`Remote show returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const oggBuffer = Buffer.from(await response.arrayBuffer());
  const filePath = await writeVoiceFile(oggBuffer);
  const result: ShowVoiceResult = {
    filePath,
    ttsMs: Date.now() - startTime,
    ttsModel: response.headers.get('X-TTS-Model') ?? model,
    voices,
    lineCount: lines.length,
    audioSeconds: Number(response.headers.get('X-TTS-Audio-Seconds')) || 0,
    audioTokens: Number(response.headers.get('X-TTS-Audio-Tokens')) || 0,
    via: 'remote',
  };
  console.log('[TTS] Remote show completed:', { ...result, oggKB: (oggBuffer.length / 1024).toFixed(2) });
  return result;
}

async function generateShowLocal(
  lines: ShowLine[],
  voices: ShowVoices,
  model: string,
  deps: ShowVoiceDeps,
): Promise<ShowVoiceResult> {
  const startTime = Date.now();
  console.log('[TTS] Generating show locally:', { lines: lines.length, model, voices });

  const audio = await synthesizeDialogue({
    apiKey: process.env.GEMINI_API_KEY || '',
    model,
    lines: lines.map(line => ({ voice: voices[line.host], text: line.text, style: line.style })),
    synthesize: deps.synthesize ?? synthesizeSpeech,
    concurrency: SHOW_LINE_CONCURRENCY,
  });

  // The Opus encoder is fixed at 24 kHz; anything else would play at the wrong speed.
  if (audio.sampleRate !== SAMPLE_RATE) {
    throw new Error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; the encoder needs ${SAMPLE_RATE} Hz`);
  }

  const pcm = mixDialogue(
    audio.pcms.map((p, i) => ({ pcm: p, speaker: lines[i].host, keepDynamics: lines[i].whisper })),
    { sampleRate: SAMPLE_RATE },
  );
  const oggBuffer = encodePcmToOggOpus(pcm);
  const filePath = await writeVoiceFile(oggBuffer);

  const result: ShowVoiceResult = {
    filePath,
    ttsMs: Date.now() - startTime,
    ttsModel: model,
    voices,
    lineCount: lines.length,
    audioSeconds: pcm.length / 2 / SAMPLE_RATE,
    audioTokens: audio.audioTokens,
    via: 'local',
  };
  console.log('[TTS] Local show completed:', { ...result, requests: audio.requests, oggKB: (oggBuffer.length / 1024).toFixed(2) });
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
