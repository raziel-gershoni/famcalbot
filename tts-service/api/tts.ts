import type { VercelRequest, VercelResponse } from '@vercel/node';
import { encodePcmToOggOpus, SAMPLE_RATE } from '../lib/pcm-to-ogg-opus.js';
import { synthesizeSpeech } from '../lib/gemini-tts.js';

// Used only when the caller sends no model. The main app now always sends one - the
// admin panel's choice - so this matters mainly for direct callers and old clients.
const DEFAULT_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';

// The model id becomes part of the upstream URL, so accept only the TTS id shape.
const TTS_MODEL_ID = /^gemini-[a-z0-9.-]+-tts(?:-preview)?$/;
const MAX_STYLE_LENGTH = 300;

const LANGUAGE_NAMES: Record<string, string> = {
  he: 'Hebrew',
  en: 'English',
  ru: 'Russian',
};

// Retry configuration
const TTS_MAX_RETRIES = 1;
const TTS_BASE_DELAY_MS = 500;

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate auth
  const authHeader = req.headers['authorization'];
  const expectedKey = process.env.TTS_API_KEY;
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { text, language, voiceName, model: requestedModel, style: requestedStyle } = req.body || {};
  if (!text || !voiceName) {
    return res.status(400).json({ error: 'Missing required fields: text, voiceName' });
  }

  const model = typeof requestedModel === 'string' && TTS_MODEL_ID.test(requestedModel)
    ? requestedModel
    : DEFAULT_TTS_MODEL;
  const style = typeof requestedStyle === 'string' && requestedStyle.length <= MAX_STYLE_LENGTH
    ? requestedStyle
    : undefined;

  console.log('[TTS] Generating voice:', {
    textLength: text.length,
    language,
    voice: voiceName,
    model,
    styled: Boolean(style),
  });

  const startTime = Date.now();

  try {
    const audio = await callWithRetry(
      () => synthesizeSpeech({
        apiKey: process.env.GEMINI_API_KEY || '',
        model,
        text,
        voiceName,
        style,
        languageName: LANGUAGE_NAMES[language] || 'English',
      }),
      TTS_MAX_RETRIES,
      TTS_BASE_DELAY_MS,
    );

    // The Opus encoder is fixed at 24 kHz; anything else would play at the wrong speed.
    if (audio.sampleRate !== SAMPLE_RATE) {
      console.error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; encoder needs ${SAMPLE_RATE} Hz`);
      return res.status(502).json({ error: `Unsupported sample rate ${audio.sampleRate}` });
    }

    console.log(`[TTS] Received ${audio.pcm.length} bytes of PCM audio (MIME: ${audio.mimeType || 'unspecified'})`);

    const oggBuffer = encodePcmToOggOpus(audio.pcm);

    const elapsed = Date.now() - startTime;
    console.log('[TTS] Voice generated:', {
      pcmKB: (audio.pcm.length / 1024).toFixed(2),
      oggKB: (oggBuffer.length / 1024).toFixed(2),
      durationMs: elapsed,
    });

    res.setHeader('Content-Type', 'audio/ogg');
    res.setHeader('X-TTS-Duration-Ms', String(elapsed));
    // Lets the caller report the model that actually spoke, not the one it asked for.
    res.setHeader('X-TTS-Model', model);
    return res.status(200).send(oggBuffer);
  } catch (error) {
    console.error('[TTS] Generation failed:', error);
    return res.status(500).json({ error: 'TTS generation failed' });
  }
}
