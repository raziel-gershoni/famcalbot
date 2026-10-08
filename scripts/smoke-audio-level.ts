// Pure-function smoke test for src/services/voice/audio-level.ts - the acoustic
// gate that stops silent voice notes from reaching the model. The model invents a
// spoken command for near-silence however it is asked, so this check is the only
// thing between an accidental recording and a fabricated calendar action.
//
// Fixtures are built with the repo's own Opus encoder, so no audio files, ffmpeg or
// network are needed.
//
// Run: npx tsx scripts/smoke-audio-level.ts

import { encodePcmToOggOpus } from '../src/utils/pcm-to-ogg-opus';
import { isSilent, measureLoudnessDbfs, SILENCE_THRESHOLD_DBFS } from '../src/services/voice/audio-level';

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

const RATE = 24000; // the encoder's input rate

/** 16-bit mono PCM from a per-sample generator returning -1..1. */
function pcm(seconds: number, sample: (i: number) => number): Buffer {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample(i) * 32767))), i * 2);
  }
  return buf;
}

/** Deterministic white noise, so a run is reproducible. */
function noise(amplitude: number) {
  let state = 12345;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return ((state / 0x7fffffff) * 2 - 1) * amplitude;
  };
}

const dbfs = (amplitudeRms: number) => 20 * Math.log10(amplitudeRms);

// 1. Digital silence - the accidental tap on the record button.
check('digital silence is -Infinity and silent', () => {
  const ogg = encodePcmToOggOpus(pcm(2, () => 0));
  const level = measureLoudnessDbfs(ogg);
  assert(level !== null && level <= SILENCE_THRESHOLD_DBFS, `level ${level}`);
  assert(isSilent(ogg), 'not flagged silent');
});

// 2. Room tone - a quiet room with nobody speaking.
check('room tone (~-65 dBFS) is silent', () => {
  const ogg = encodePcmToOggOpus(pcm(3, noise(0.001)));
  const level = measureLoudnessDbfs(ogg);
  assert(level !== null && level < SILENCE_THRESHOLD_DBFS, `level ${level}`);
  assert(isSilent(ogg), 'not flagged silent');
});

// 3. Anything at speech level must pass through to the model.
check('speech-level noise (~-25 dBFS) is not silent', () => {
  const ogg = encodePcmToOggOpus(pcm(3, noise(0.1)));
  const level = measureLoudnessDbfs(ogg);
  assert(level !== null && level > -35, `level ${level}`);
  assert(!isSilent(ogg), 'flagged silent');
});

// A whisper close to the phone is far louder than the threshold; this pins the
// headroom so the threshold cannot drift up into real speech unnoticed.
check('quiet speech-like level (~-40 dBFS) is not silent', () => {
  const ogg = encodePcmToOggOpus(pcm(3, noise(0.017)));
  assert(!isSilent(ogg), `flagged silent at ${measureLoudnessDbfs(ogg)}`);
});

// 4. The measurement itself tracks true loudness: a sine at a known RMS.
check('sine level is measured within 1.5 dB', () => {
  const amp = 0.35; // RMS = amp / sqrt(2)
  const expected = dbfs(amp / Math.SQRT2);
  const ogg = encodePcmToOggOpus(pcm(2, i => amp * Math.sin((2 * Math.PI * 440 * i) / RATE)));
  const level = measureLoudnessDbfs(ogg);
  assert(level !== null && Math.abs(level - expected) <= 1.5, `measured ${level}, expected ${expected.toFixed(1)}`);
});

// 5. Unmeasurable input must fail open - treated as possibly speech, never silent.
check('non-OGG input returns null and is not silent', () => {
  const junk = Buffer.from('definitely not an ogg stream');
  assert(measureLoudnessDbfs(junk) === null, 'expected null');
  assert(!isSilent(junk), 'garbage flagged silent');
});

check('empty input returns null and is not silent', () => {
  assert(measureLoudnessDbfs(Buffer.alloc(0)) === null, 'expected null');
  assert(!isSilent(Buffer.alloc(0)), 'empty flagged silent');
});

check('truncated OGG returns null and is not silent', () => {
  const ogg = encodePcmToOggOpus(pcm(2, noise(0.2)));
  const cut = ogg.subarray(0, 40);
  assert(!isSilent(cut), `truncated flagged silent (level ${measureLoudnessDbfs(cut)})`);
});

// Print results
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
