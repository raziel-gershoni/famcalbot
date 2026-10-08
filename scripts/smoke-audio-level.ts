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
import { isSilent, loudestWindowDbfs, MAX_MEASURED_SECONDS, SILENCE_THRESHOLD_DBFS } from '../src/services/voice/audio-level';

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
  const level = loudestWindowDbfs(ogg);
  assert(level !== null && level <= SILENCE_THRESHOLD_DBFS, `level ${level}`);
  assert(isSilent(ogg), 'not flagged silent');
});

// 2. Room tone - a quiet room with nobody speaking.
check('room tone (~-65 dBFS) is silent', () => {
  const ogg = encodePcmToOggOpus(pcm(3, noise(0.001)));
  const level = loudestWindowDbfs(ogg);
  assert(level !== null && level < SILENCE_THRESHOLD_DBFS, `level ${level}`);
  assert(isSilent(ogg), 'not flagged silent');
});

// 3. Anything at speech level must pass through to the model.
check('speech-level noise (~-25 dBFS) is not silent', () => {
  const ogg = encodePcmToOggOpus(pcm(3, noise(0.1)));
  const level = loudestWindowDbfs(ogg);
  assert(level !== null && level > -35, `level ${level}`);
  assert(!isSilent(ogg), 'flagged silent');
});

// A whisper close to the phone is far louder than the threshold; this pins the
// headroom so the threshold cannot drift up into real speech unnoticed.
check('quiet speech-like level (~-40 dBFS) is not silent', () => {
  const ogg = encodePcmToOggOpus(pcm(3, noise(0.017)));
  assert(!isSilent(ogg), `flagged silent at ${loudestWindowDbfs(ogg)}`);
});

// 4. The measurement itself tracks true loudness: a sine at a known RMS.
check('sine level is measured within 1.5 dB', () => {
  const amp = 0.35; // RMS = amp / sqrt(2)
  const expected = dbfs(amp / Math.SQRT2);
  const ogg = encodePcmToOggOpus(pcm(2, i => amp * Math.sin((2 * Math.PI * 440 * i) / RATE)));
  const level = loudestWindowDbfs(ogg);
  assert(level !== null && Math.abs(level - expected) <= 1.5, `measured ${level}, expected ${expected.toFixed(1)}`);
});

// 5. Regression: a short, quiet command inside a mostly-quiet note. Averaging the
// whole clip let the surrounding silence drag this below the threshold, so a real
// command - a parent whispering by a sleeping child, a phone across the kitchen - was
// dropped as "no speech". The loudest window measures the speech itself.
check('quiet 2s command inside a 14s note is NOT silent', () => {
  // Uniform noise of amplitude a has RMS a/sqrt(3).
  const room = noise(0.00025); // ~-77 dBFS
  // ~-44 dBFS: the level measured for real speech said quietly or across a room
  // (-42.5 to -47 dBFS on the loudest window). The whole-clip average of 2s of this in
  // a 14s note is ~-52.5 dBFS - below the threshold, which is the bug this pins.
  const speech = noise(0.011);
  const total = 14 * RATE;
  const start = 6 * RATE;
  const end = 8 * RATE;
  const ogg = encodePcmToOggOpus(pcm(14, i => (i >= start && i < end ? speech() : room())));
  const level = loudestWindowDbfs(ogg);
  assert(level !== null && level > SILENCE_THRESHOLD_DBFS, `loudest window ${level} - a whole-clip average would be ~10 dB lower`);
  assert(!isSilent(ogg), 'real command dropped as silence');
  void total;
});

// 6. Regression: decoding is synchronous on the process that serves every webhook,
// and WhatsApp notes have no length cap. Speech must stop the decode early.
check('a loud 90s note is judged within its first second of audio', () => {
  const ogg = encodePcmToOggOpus(pcm(90, noise(0.2)));
  const started = Date.now();
  const silent = isSilent(ogg);
  const ms = Date.now() - started;
  assert(!silent, 'loud note flagged silent');
  assert(ms < 50, `took ${ms}ms - early stop is not working`);
});

// ...and a long quiet note gives up at the cap rather than decoding everything.
check(`a quiet note longer than ${MAX_MEASURED_SECONDS}s is unmeasurable, not silent`, () => {
  const ogg = encodePcmToOggOpus(pcm(MAX_MEASURED_SECONDS + 5, () => 0));
  assert(loudestWindowDbfs(ogg) === null, 'expected null past the cap');
  assert(!isSilent(ogg), 'long note flagged silent - should fall through to the model gate');
});

// 7. Unmeasurable input must fail open - treated as possibly speech, never silent.
check('non-OGG input returns null and is not silent', () => {
  const junk = Buffer.from('definitely not an ogg stream');
  assert(loudestWindowDbfs(junk) === null, 'expected null');
  assert(!isSilent(junk), 'garbage flagged silent');
});

check('empty input returns null and is not silent', () => {
  assert(loudestWindowDbfs(Buffer.alloc(0)) === null, 'expected null');
  assert(!isSilent(Buffer.alloc(0)), 'empty flagged silent');
});

check('truncated OGG returns null and is not silent', () => {
  const ogg = encodePcmToOggOpus(pcm(2, noise(0.2)));
  const cut = ogg.subarray(0, 40);
  assert(!isSilent(cut), `truncated flagged silent (level ${loudestWindowDbfs(cut)})`);
});

// Print results
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
