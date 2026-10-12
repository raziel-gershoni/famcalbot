// Pure-function smoke test for src/services/gemini-tts.ts.
// Covers the audio decoding that broke silently on the move to Gemini 3.8 TTS, and
// the 3.8 request shape. No network; safe to run anywhere.
//
// Run: npx tsx scripts/smoke-tts.ts

import fs from 'fs';
import { buildTtsRequestBody, decodeSpeechAudio, extractSpeechAudio } from '../src/services/gemini-tts';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function chunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, body, pad]);
}

function fmtChunk(opts: { format?: number; channels?: number; rate?: number; bits?: number } = {}): Buffer {
  const { format = 1, channels = 1, rate = 24000, bits = 16 } = opts;
  const b = Buffer.alloc(16);
  b.writeUInt16LE(format, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE(rate * channels * (bits / 8), 8);
  b.writeUInt16LE(channels * (bits / 8), 12);
  b.writeUInt16LE(bits, 14);
  return chunk('fmt ', b);
}

function wav(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const samples = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
// Stand-in for the content-credentials block Gemini 3.8 appends after the audio.
const c2pa = chunk('C2PA', Buffer.alloc(6070, 0xff));

// 1. The actual 3.8 regression: a trailing C2PA chunk must not become audio.
check('WAV with trailing C2PA chunk yields only the data chunk', () => {
  const { pcm, sampleRate } = decodeSpeechAudio(wav(fmtChunk(), chunk('data', samples), c2pa), 'audio/wav');
  assert(pcm.equals(samples), `expected ${samples.length} sample bytes, got ${pcm.length}`);
  assert(sampleRate === 24000, `rate ${sampleRate}`);
});

// 2. A header that is not 44 bytes: an extra chunk before data.
check('WAV with a LIST chunk before data is not mis-sliced', () => {
  const list = chunk('LIST', Buffer.from('INFOISFT\x05\x00\x00\x00test\x00', 'binary'));
  const { pcm } = decodeSpeechAudio(wav(fmtChunk(), list, chunk('data', samples)), 'audio/wav');
  assert(pcm.equals(samples), `got ${pcm.length} bytes`);
});

// 3. Odd-sized chunks are padded to a word boundary.
check('odd-sized chunk padding is respected', () => {
  const odd = chunk('junk', Buffer.from([9, 9, 9]));
  const { pcm } = decodeSpeechAudio(wav(fmtChunk(), odd, chunk('data', samples)), 'audio/wav');
  assert(pcm.equals(samples), `got ${pcm.length} bytes`);
});

// 4. A WAV mislabelled as raw PCM is still unwrapped.
check('RIFF bytes are sniffed even when declared audio/l16', () => {
  const { pcm } = decodeSpeechAudio(wav(fmtChunk(), chunk('data', samples), c2pa), 'audio/l16; rate=24000');
  assert(pcm.equals(samples), `got ${pcm.length} bytes`);
});

// 5. Raw PCM, with the rate read from the MIME parameter - case-insensitively.
check('audio/l16 passes through and reads rate=', () => {
  const { pcm, sampleRate } = decodeSpeechAudio(samples, 'audio/l16; rate=24000; channels=1');
  assert(pcm.equals(samples), 'pcm altered');
  assert(sampleRate === 24000, `rate ${sampleRate}`);
});

check('upper-case audio/L16 is recognised', () => {
  const { sampleRate } = decodeSpeechAudio(samples, 'audio/L16;rate=16000');
  assert(sampleRate === 16000, `rate ${sampleRate}`);
});

check('missing rate defaults to 24000', () => {
  assert(decodeSpeechAudio(samples, 'audio/l16').sampleRate === 24000, 'default rate');
  assert(decodeSpeechAudio(samples, '').sampleRate === 24000, 'empty mime');
});

// 6. Formats the encoder cannot take must fail loudly, not produce noise.
check('stereo WAV is rejected', () => {
  let threw = false;
  try { decodeSpeechAudio(wav(fmtChunk({ channels: 2 }), chunk('data', samples)), 'audio/wav'); } catch { threw = true; }
  assert(threw, 'stereo accepted');
});

check('8-bit WAV is rejected', () => {
  let threw = false;
  try { decodeSpeechAudio(wav(fmtChunk({ bits: 8 }), chunk('data', samples)), 'audio/wav'); } catch { threw = true; }
  assert(threw, '8-bit accepted');
});

check('unknown audio type is rejected', () => {
  let threw = false;
  try { decodeSpeechAudio(samples, 'audio/mpeg'); } catch { threw = true; }
  assert(threw, 'mp3 accepted');
});

check('WAV with no data chunk is rejected', () => {
  let threw = false;
  try { decodeSpeechAudio(wav(fmtChunk()), 'audio/wav'); } catch { threw = true; }
  assert(threw, 'accepted');
});

// 7. The 3.8 request shape.
check('3.8 request: bare text, style in speechMetadata, AUDIO_L16', () => {
  const body = buildTtsRequestBody({
    apiKey: 'x', model: 'gemini-3.8-flash-tts', text: 'Good morning', voiceName: 'Achird', style: 'softly',
  }) as { contents: Array<{ parts: Array<Record<string, unknown>> }>; generationConfig: Record<string, unknown> };
  const part = body.contents[0].parts[0];
  assert(part.text === 'Good morning', `text was rewritten: ${String(part.text)}`);
  assert((part.speechMetadata as { style?: string })?.style === 'softly', 'style not in speechMetadata');
  assert(JSON.stringify(body.generationConfig.responseFormat) === '{"audio":{"mimeType":"AUDIO_L16"}}', 'no AUDIO_L16');
});

check('3.8 request without a style sends no speechMetadata', () => {
  const body = buildTtsRequestBody({ apiKey: 'x', model: 'gemini-3.8-flash-tts', text: 'Hi', voiceName: 'Achird' }) as {
    contents: Array<{ parts: Array<Record<string, unknown>> }>;
  };
  assert(!('speechMetadata' in body.contents[0].parts[0]), 'unexpected speechMetadata');
});

// 8. Voices are built-in names in prebuiltVoiceConfig.
check('voice goes in prebuiltVoiceConfig', () => {
  const body = buildTtsRequestBody({ apiKey: 'x', model: 'gemini-3.8-flash-tts', text: 'Hi', voiceName: 'Algieba' }) as {
    generationConfig: { speechConfig: Record<string, unknown> };
  };
  const json = JSON.stringify(body.generationConfig.speechConfig);
  assert(json === '{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Algieba"}}}', `speechConfig was ${json}`);
});

// 9. Multi-part responses: every audio part, in order; tokens from usageMetadata.
check('all audio parts are joined in order, tokens read', () => {
  const a = Buffer.from([1, 0, 2, 0]);
  const b = Buffer.from([3, 0, 4, 0]);
  const audio = extractSpeechAudio({
    candidates: [{ content: { parts: [
      { inlineData: { mimeType: 'audio/l16; rate=24000', data: a.toString('base64') } },
      { inlineData: { mimeType: 'audio/l16; rate=24000', data: b.toString('base64') } },
    ] } }],
    usageMetadata: { candidatesTokenCount: 125 },
  }, 'gemini-3.8-flash-tts');
  assert(audio.pcm.equals(Buffer.concat([a, b])), `pcm ${audio.pcm.toString('hex')}`);
  assert(audio.sampleRate === 24000, `rate ${audio.sampleRate}`);
  assert(audio.audioTokens === 125, `tokens ${audio.audioTokens}`);
});

check('response without audio parts throws "returned no audio"', () => {
  let message = '';
  try { extractSpeechAudio({ candidates: [{ content: { parts: [] } }] }, 'm'); } catch (e) { message = (e as Error).message; }
  assert(/returned no audio/.test(message), `message ${message}`);
});

check('audio parts at different rates are refused', () => {
  let threw = false;
  try {
    extractSpeechAudio({ candidates: [{ content: { parts: [
      { inlineData: { mimeType: 'audio/l16; rate=24000', data: 'AQA=' } },
      { inlineData: { mimeType: 'audio/l16; rate=16000', data: 'AQA=' } },
    ] } }] }, 'm');
  } catch { threw = true; }
  assert(threw, 'mixed rates accepted');
});

check('missing token count leaves audioTokens undefined', () => {
  const audio = extractSpeechAudio({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/l16', data: 'AQA=' } }] } }] }, 'm');
  assert(audio.audioTokens === undefined, `tokens ${audio.audioTokens}`);
});

// 10. tts-service deploys separately and carries verbatim copies of the shared library.
const TWINS: Array<[string, string]> = [
  ['src/services/gemini-tts.ts', 'tts-service/lib/gemini-tts.ts'],
  ['src/utils/pcm-to-ogg-opus.ts', 'tts-service/lib/pcm-to-ogg-opus.ts'],
  ['src/services/dialogue-tts.ts', 'tts-service/lib/dialogue-tts.ts'],
  ['src/utils/pcm-mix.ts', 'tts-service/lib/pcm-mix.ts'],
];
for (const [app, service] of TWINS) {
  check(`${service} is identical to ${app}`, () => {
    assert(fs.readFileSync(app).equals(fs.readFileSync(service)), 'copies differ - copy the src/ file over the tts-service one');
  });
}

// Print results
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
