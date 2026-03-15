import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI } from '@google/genai';
import { encodePcmToOggOpus } from '../lib/pcm-to-ogg-opus.js';

const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

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

  const { text, language, voiceName } = req.body || {};
  if (!text || !voiceName) {
    return res.status(400).json({ error: 'Missing required fields: text, voiceName' });
  }

  const langName = LANGUAGE_NAMES[language] || 'English';
  const ttsPrompt = `Read the following text aloud naturally in ${langName}:\n\n${text}`;

  console.log('[TTS] Generating voice:', {
    textLength: text.length,
    language,
    voice: voiceName,
    model: GEMINI_TTS_MODEL,
  });

  const startTime = Date.now();

  try {
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

    const result = await callWithRetry(async () => {
      return await genai.models.generateContent({
        model: GEMINI_TTS_MODEL,
        contents: [{ parts: [{ text: ttsPrompt }] }],
        config: {
          temperature: 0,
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
      return res.status(502).json({ error: 'No audio data in Gemini TTS response' });
    }

    // Decode base64 to raw PCM buffer
    const mimeType = inlineData.mimeType || '';
    let pcmBuffer = Buffer.from(inlineData.data, 'base64');

    // Strip WAV header if present (44 bytes)
    if (mimeType.includes('audio/wav') || mimeType.includes('audio/x-wav')) {
      if (pcmBuffer.length > 44) {
        pcmBuffer = pcmBuffer.subarray(44);
      }
    }

    console.log(`[TTS] Received ${pcmBuffer.length} bytes of PCM audio (MIME: ${mimeType || 'unspecified'})`);

    // Convert PCM to OGG OPUS
    const oggBuffer = encodePcmToOggOpus(pcmBuffer);

    const elapsed = Date.now() - startTime;
    console.log('[TTS] Voice generated:', {
      pcmKB: (pcmBuffer.length / 1024).toFixed(2),
      oggKB: (oggBuffer.length / 1024).toFixed(2),
      durationMs: elapsed,
    });

    res.setHeader('Content-Type', 'audio/ogg');
    res.setHeader('X-TTS-Duration-Ms', String(elapsed));
    return res.status(200).send(oggBuffer);
  } catch (error) {
    console.error('[TTS] Generation failed:', error);
    return res.status(500).json({ error: 'TTS generation failed' });
  }
}
