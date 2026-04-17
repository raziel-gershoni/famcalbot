/**
 * Voice Generation Service
 * Generates speech from text using Gemini 3.1 Flash TTS
 * Replaces the previous Google Cloud TTS implementation
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { getGemini } from './ai-provider';
import { encodePcmToOggOpus } from '../utils/pcm-to-ogg-opus';
import { getVoiceForUser, VOICE_STYLE_PROMPTS } from '../config/voice-options';

// Model ID configurable via env var (prevents production outage on preview→GA rename)
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';

// Voice config per language (with env var overrides)
// All male voices, matching previous Google TTS Wavenet-D male voices
const VOICE_CONFIG: Record<string, string> = {
  he: process.env.GEMINI_TTS_VOICE_HE || 'Algieba',   // Smooth male — Hebrew
  en: process.env.GEMINI_TTS_VOICE_EN || 'Achird',     // Friendly male — English
  ru: process.env.GEMINI_TTS_VOICE_RU || 'Schedar',    // Even male — Russian
};

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

/**
 * Generate voice message from condensed text using Gemini TTS
 * @param condensedText - Plain text already condensed by LLM
 * @param language - Language code (e.g., 'he', 'en', 'ru')
 * @returns Path to generated OGG OPUS audio file in /tmp
 */
export interface VoiceGenerationResult {
  filePath: string;
  ttsMs: number;
  ttsModel: string;
  voiceName: string;
}

// Remote TTS timeout (30s — generous but below Vercel's 60s maxDuration)
const REMOTE_TTS_TIMEOUT_MS = 30_000;

/**
 * Generate voice via remote serverless TTS function.
 * Returns OGG OPUS binary written to /tmp.
 */
async function generateVoiceRemote(
  text: string,
  language: string,
  voiceName: string,
): Promise<VoiceGenerationResult> {
  const startTime = Date.now();
  const url = `${process.env.TTS_SERVICE_URL}/api/tts`;

  console.log('[TTS] Calling remote TTS service:', {
    url,
    textLength: text.length,
    language,
    voice: voiceName,
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
      body: JSON.stringify({ text, language, voiceName }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Remote TTS returned ${response.status}: ${body}`);
    }

    const oggBuffer = Buffer.from(await response.arrayBuffer());
    const remoteDurationMs = response.headers.get('X-TTS-Duration-Ms');

    // Write to temp file
    const randomId = randomBytes(4).toString('hex');
    const filename = `voice-${Date.now()}-${randomId}.opus`;
    const filePath = path.join('/tmp', filename);
    await fs.writeFile(filePath, oggBuffer);

    const elapsed = Date.now() - startTime;
    console.log('[TTS] Remote TTS completed:', {
      filePath,
      oggKB: (oggBuffer.length / 1024).toFixed(2),
      remoteDurationMs,
      totalMs: elapsed,
    });

    return { filePath, ttsMs: elapsed, ttsModel: GEMINI_TTS_MODEL, voiceName };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateVoiceMessage(
  condensedText: string,
  language: string = 'en',
  voicePreference?: string,
  voiceStyle?: string,
): Promise<VoiceGenerationResult> {
  const voiceName = voicePreference && voicePreference !== 'default'
    ? getVoiceForUser(language, voicePreference)
    : VOICE_CONFIG[language] || VOICE_CONFIG['en'] || 'Achird';

  // If TTS_SERVICE_URL is set, offload to remote serverless function
  if (process.env.TTS_SERVICE_URL) {
    try {
      return await generateVoiceRemote(condensedText, language, voiceName);
    } catch (error) {
      console.warn('[TTS] Remote TTS failed, falling back to local:', error);
    }
  }

  // Local generation (existing code)
  const startTime = Date.now();
  const langName = LANGUAGE_NAMES[language] || 'English';

  // Build minimal TTS-only prompt — no reasoning, just speak
  const styleInstruction = VOICE_STYLE_PROMPTS[voiceStyle || 'natural'] || VOICE_STYLE_PROMPTS.natural;
  const ttsPrompt = `Read the following text aloud ${styleInstruction} in ${langName}:\n\n${condensedText}`;

  console.log('[TTS] Generating voice message (Gemini TTS):', {
    textLength: condensedText.length,
    language,
    voice: voiceName,
    model: GEMINI_TTS_MODEL,
  });

  // Call Gemini TTS with retry and timeout
  const result = await callWithRetry(async () => {
    return await getGemini().models.generateContent({
      model: GEMINI_TTS_MODEL,
      contents: [{ parts: [{ text: ttsPrompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });
  }, TTS_MAX_RETRIES, TTS_BASE_DELAY_MS);

  // Validate response
  const inlineData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    throw new Error('[TTS] No audio data in Gemini TTS response');
  }

  // Validate MIME type — Gemini TTS should return raw PCM
  const mimeType = inlineData.mimeType || '';
  if (mimeType && !mimeType.includes('audio/L16') && !mimeType.includes('audio/pcm') && mimeType !== '') {
    if (mimeType.includes('audio/wav') || mimeType.includes('audio/x-wav')) {
      console.log(`[TTS] Received WAV MIME type (${mimeType}), will strip 44-byte header`);
    } else if (!mimeType.startsWith('audio/')) {
      throw new Error(`[TTS] Unexpected MIME type from Gemini TTS: ${mimeType}`);
    }
  }

  // Decode base64 to raw PCM buffer
  let pcmBuffer = Buffer.from(inlineData.data, 'base64');

  // Strip WAV header if present (44 bytes)
  if (mimeType.includes('audio/wav') || mimeType.includes('audio/x-wav')) {
    if (pcmBuffer.length > 44) {
      pcmBuffer = pcmBuffer.subarray(44);
    }
  }

  console.log(`[TTS] Received ${pcmBuffer.length} bytes of PCM audio (MIME: ${mimeType || 'unspecified'})`);

  // Convert PCM to OGG OPUS — encoder handles frame truncation internally
  const oggBuffer = encodePcmToOggOpus(pcmBuffer);

  // Write to temp file
  const randomId = randomBytes(4).toString('hex');
  const filename = `voice-${Date.now()}-${randomId}.opus`;
  const filePath = path.join('/tmp', filename);
  await fs.writeFile(filePath, oggBuffer);

  const elapsed = Date.now() - startTime;
  console.log('[TTS] Voice generated successfully:', {
    filePath,
    pcmKB: (pcmBuffer.length / 1024).toFixed(2),
    oggKB: (oggBuffer.length / 1024).toFixed(2),
    durationMs: elapsed,
  });

  return { filePath, ttsMs: elapsed, ttsModel: GEMINI_TTS_MODEL, voiceName };
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
