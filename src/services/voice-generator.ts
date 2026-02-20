/**
 * Voice Generation Service
 * Generates speech from text using Gemini 2.5 Flash TTS
 * Replaces the previous Google Cloud TTS implementation
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { getGemini } from './ai-provider';
import { encodePcmToOggOpus } from '../utils/pcm-to-ogg-opus';

// Model ID configurable via env var (prevents production outage on preview→GA rename)
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

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
const TTS_TIMEOUT_MS = 30000; // 30 second timeout

/**
 * Retry wrapper with timeout using Promise.race
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TTS_TIMEOUT')), TTS_TIMEOUT_MS);
      });
      const result = await Promise.race([fn(), timeoutPromise]);
      clearTimeout(timer);
      return result;
    } catch (error: unknown) {
      clearTimeout(timer);
      const err = error as { message?: string; status?: number };
      const isRetryable = err.message === 'TTS_TIMEOUT'
        || err.status === 503 || err.status === 429;
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
export async function generateVoiceMessage(
  condensedText: string,
  language: string = 'en',
): Promise<string> {
  const startTime = Date.now();
  const voiceName = VOICE_CONFIG[language] || VOICE_CONFIG['en'] || 'Achird';
  const langName = LANGUAGE_NAMES[language] || 'English';

  // Build minimal TTS-only prompt — no reasoning, just speak
  const ttsPrompt = `Read the following text aloud naturally in ${langName}:\n\n${condensedText}`;

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

  return filePath;
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
