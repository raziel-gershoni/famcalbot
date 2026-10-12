import type { VercelRequest, VercelResponse } from '@vercel/node';
import { encodePcmToOggOpus, SAMPLE_RATE } from '../lib/pcm-to-ogg-opus.js';
import { isVoiceMissingError, modelForDesignedVoices, synthesizeSpeech } from '../lib/gemini-tts.js';
import { synthesizeDialogue } from '../lib/dialogue-tts.js';
import { mixDialogue } from '../lib/pcm-mix.js';

// The two-host show: every line synthesized in parallel in its host's voice, mixed,
// and encoded once. Same auth and function limits as api/tts.ts. The main app falls
// back to local synthesis on any non-200 from here.

// Used only when the caller sends no valid model. The main app always sends one.
const DEFAULT_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';

// The model id becomes part of the upstream URL, so accept only the TTS id shape.
const TTS_MODEL_ID = /^gemini-[a-z0-9.-]+-tts(?:-preview)?$/;
// A designed voice id (voice_...) or a prebuilt voice name (Algieba).
const VOICE_ID = /^(?:voice_[A-Za-z0-9]{4,64}|[A-Z][a-z]{2,20})$/;
const MAX_LINES = 30;
// The app caps a turn at 400 characters; niqqud added after that makes lines longer.
const MAX_LINE_CHARS = 1000;
const MAX_STYLE_LENGTH = 300;
const LINE_CONCURRENCY = 8;

interface Line {
  host: 'A' | 'B';
  text: string;
  style?: string;
  whisper: boolean;
}

interface ShowRequest {
  model: string;
  voices: { A: string; B: string };
  lines: Line[];
}

/** The validated request, or the reason it was refused. */
function parseRequest(body: unknown): ShowRequest | string {
  const b = (body ?? {}) as { model?: unknown; voices?: unknown; lines?: unknown };
  const voices = (b.voices ?? {}) as { A?: unknown; B?: unknown };
  if (typeof voices.A !== 'string' || !VOICE_ID.test(voices.A) || typeof voices.B !== 'string' || !VOICE_ID.test(voices.B)) {
    return 'voices must be { A, B } voice ids';
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > MAX_LINES) {
    return `lines must be an array of 1-${MAX_LINES} lines`;
  }

  const lines: Line[] = [];
  for (const [i, raw] of b.lines.entries()) {
    const l = (raw ?? {}) as { host?: unknown; text?: unknown; style?: unknown; whisper?: unknown };
    if (l.host !== 'A' && l.host !== 'B') return `line ${i + 1}: host must be A or B`;
    if (typeof l.text !== 'string' || !l.text.trim() || l.text.length > MAX_LINE_CHARS) {
      return `line ${i + 1}: text must be 1-${MAX_LINE_CHARS} characters`;
    }
    if (l.style !== undefined && (typeof l.style !== 'string' || l.style.length > MAX_STYLE_LENGTH)) {
      return `line ${i + 1}: style must be a string of at most ${MAX_STYLE_LENGTH} characters`;
    }
    lines.push({ host: l.host, text: l.text, style: l.style, whisper: l.whisper === true });
  }

  const requested = typeof b.model === 'string' && TTS_MODEL_ID.test(b.model) ? b.model : DEFAULT_TTS_MODEL;
  // Legacy models cannot speak designed voices.
  return { model: modelForDesignedVoices(requested), voices: { A: voices.A, B: voices.B }, lines };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedKey = process.env.TTS_API_KEY;
  if (!expectedKey || req.headers['authorization'] !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parsed = parseRequest(req.body);
  if (typeof parsed === 'string') {
    return res.status(400).json({ error: parsed });
  }
  const { model, voices, lines } = parsed;

  console.log('[TTS] Generating show:', { lines: lines.length, model, voices });
  const startTime = Date.now();

  try {
    const audio = await synthesizeDialogue({
      apiKey: process.env.GEMINI_API_KEY || '',
      model,
      lines: lines.map(line => ({ voice: voices[line.host], text: line.text, style: line.style })),
      synthesize: synthesizeSpeech,
      concurrency: LINE_CONCURRENCY,
    });

    // The Opus encoder is fixed at 24 kHz; anything else would play at the wrong speed.
    if (audio.sampleRate !== SAMPLE_RATE) {
      console.error(`[TTS] ${model} returned ${audio.sampleRate} Hz audio; encoder needs ${SAMPLE_RATE} Hz`);
      return res.status(502).json({ error: `Unsupported sample rate ${audio.sampleRate}` });
    }

    const pcm = mixDialogue(
      audio.pcms.map((p, i) => ({ pcm: p, speaker: lines[i].host, keepDynamics: lines[i].whisper })),
      { sampleRate: SAMPLE_RATE },
    );
    const oggBuffer = encodePcmToOggOpus(pcm);
    const elapsed = Date.now() - startTime;
    const audioSeconds = pcm.length / 2 / SAMPLE_RATE;

    console.log('[TTS] Show generated:', {
      requests: audio.requests,
      audioSeconds: audioSeconds.toFixed(1),
      oggKB: (oggBuffer.length / 1024).toFixed(2),
      durationMs: elapsed,
    });

    res.setHeader('Content-Type', 'audio/ogg');
    res.setHeader('X-TTS-Duration-Ms', String(elapsed));
    res.setHeader('X-TTS-Model', model);
    res.setHeader('X-TTS-Audio-Seconds', audioSeconds.toFixed(2));
    res.setHeader('X-TTS-Audio-Tokens', String(audio.audioTokens));
    return res.status(200).send(oggBuffer);
  } catch (error) {
    console.error('[TTS] Show generation failed:', error);
    if (isVoiceMissingError(error)) {
      return res.status(422).json({ error: 'voice_not_found' });
    }
    return res.status(500).json({ error: 'TTS generation failed' });
  }
}
