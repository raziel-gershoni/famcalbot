// Smoke test for src/utils/pcm-mix.ts with synthetic tones. No network.
//
// Run: npx tsx scripts/smoke-pcm-mix.ts

import { activeRms, mixDialogue, trimSilence } from '../src/utils/pcm-mix';

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

const RATE = 24000;
const samples = (ms: number) => Math.round((RATE * ms) / 1000);

function tone(ms: number, amp: number, freq = 220): Buffer {
  const n = samples(ms);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(samples(ms) * 2);
const padded = (amp: number, ms = 1000) => Buffer.concat([silence(500), tone(ms, amp), silence(400)]);
const db = (ratio: number) => 20 * Math.log10(ratio);

function segments(lines: Buffer[], gapMs = 200): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let pos = 0;
  lines.forEach((pcm, i) => {
    if (i > 0) pos += samples(gapMs);
    const n = trimSilence(pcm, RATE).length / 2;
    out.push([pos, pos + n]);
    pos += n;
  });
  return out;
}
const slice = (pcm: Buffer, [from, to]: [number, number]) => pcm.subarray(from * 2, to * 2);

check('trimSilence keeps the sound plus a 40 ms edge each side', () => {
  const trimmed = trimSilence(padded(8000), RATE);
  const ms = (trimmed.length / 2 / RATE) * 1000;
  assert(ms >= 1060 && ms <= 1110, `trimmed to ${ms.toFixed(0)} ms`);
});

check('trimSilence of pure silence is empty', () => {
  assert(trimSilence(silence(300), RATE).length === 0, 'not empty');
});

check('total length = trimmed lines + gaps', () => {
  const lines = [padded(8000), padded(8000, 600), padded(8000, 800)];
  const mixed = mixDialogue(lines.map((pcm, i) => ({ pcm, speaker: i % 2 ? 'B' : 'A' })), { sampleRate: RATE });
  const expected = lines.reduce((s, l) => s + trimSilence(l, RATE).length, 0) + 2 * samples(200) * 2;
  assert(mixed.length === expected, `length ${mixed.length} expected ${expected}`);
});

check('gaps are silent and lines fade in and out', () => {
  const lines = [padded(8000), padded(8000)];
  const mixed = mixDialogue([{ pcm: lines[0], speaker: 'A' }, { pcm: lines[1], speaker: 'B' }], { sampleRate: RATE });
  const [first, second] = segments(lines);
  for (let i = first[1]; i < second[0]; i++) assert(mixed.readInt16LE(i * 2) === 0, `gap sample ${i} not silent`);
  assert(mixed.readInt16LE(first[0] * 2) === 0, 'first sample of a line is not 0');
  assert(mixed.readInt16LE((first[1] - 1) * 2) === 0, 'last sample of a line is not 0');
});

check('hosts recorded 6 dB apart come out level', () => {
  const lines = [padded(6000), padded(3000), padded(6000), padded(3000)];
  const mixed = mixDialogue(lines.map((pcm, i) => ({ pcm, speaker: i % 2 ? 'B' : 'A' })), { sampleRate: RATE });
  const segs = segments(lines);
  const a = activeRms(slice(mixed, segs[0]), RATE);
  const b = activeRms(slice(mixed, segs[1]), RATE);
  assert(Math.abs(db(a / b)) < 0.5, `A/B differ by ${db(a / b).toFixed(2)} dB`);
});

check('gain never exceeds maxGainDb', () => {
  const lines = [padded(16000), padded(1000)];
  const mixed = mixDialogue(lines.map((pcm, i) => ({ pcm, speaker: i ? 'B' : 'A' })), { sampleRate: RATE, maxGainDb: 6 });
  const segs = segments(lines);
  const before = activeRms(trimSilence(lines[1], RATE), RATE);
  const after = activeRms(slice(mixed, segs[1]), RATE);
  assert(db(after / before) <= 6.05, `B boosted by ${db(after / before).toFixed(2)} dB`);
});

check('whispered lines keep their level below the host', () => {
  const lines = [padded(6000), padded(3000), padded(600)];
  const mixed = mixDialogue([
    { pcm: lines[0], speaker: 'A' },
    { pcm: lines[1], speaker: 'B' },
    { pcm: lines[2], speaker: 'B', keepDynamics: true },
  ], { sampleRate: RATE });
  const segs = segments(lines);
  const normal = activeRms(slice(mixed, segs[1]), RATE);
  const whisper = activeRms(slice(mixed, segs[2]), RATE);
  assert(Math.abs(db(whisper / normal) - db(600 / 3000)) < 0.5, `whisper at ${db(whisper / normal).toFixed(2)} dB`);
});

check('peak guard scales the whole show below 95% of full scale', () => {
  // B's gain (x1.5, from its normal line) would push its loud keepDynamics line to 48000.
  const lines = [padded(6000), padded(3000), padded(32000)];
  const mixed = mixDialogue([
    { pcm: lines[0], speaker: 'A' },
    { pcm: lines[1], speaker: 'B' },
    { pcm: lines[2], speaker: 'B', keepDynamics: true },
  ], { sampleRate: RATE });
  let peak = 0;
  for (let i = 0; i < mixed.length; i += 2) peak = Math.max(peak, Math.abs(mixed.readInt16LE(i)));
  assert(peak <= Math.ceil(32767 * 0.95), `peak ${peak}`);
  assert(peak >= 31000, `peak ${peak}: the loud line should sit at the ceiling, not below it`);
});

check('silent lines are dropped; all-silent dialogue throws', () => {
  const mixed = mixDialogue([{ pcm: padded(8000), speaker: 'A' }, { pcm: silence(500), speaker: 'B' }], { sampleRate: RATE });
  assert(mixed.length === trimSilence(padded(8000), RATE).length, `length ${mixed.length}`);
  let threw = false;
  try { mixDialogue([{ pcm: silence(500), speaker: 'A' }], { sampleRate: RATE }); } catch { threw = true; }
  assert(threw, 'all-silent accepted');
});

check('odd-length input is tolerated', () => {
  const odd = Buffer.concat([padded(8000), Buffer.from([1])]);
  const mixed = mixDialogue([{ pcm: odd, speaker: 'A' }], { sampleRate: RATE });
  assert(mixed.length % 2 === 0 && mixed.length > 0, `length ${mixed.length}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
