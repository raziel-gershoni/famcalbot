/**
 * Joins the separately synthesized lines of a two-host dialogue into one PCM stream.
 *
 * Each TTS line arrives with its own lead-in and tail of silence and its own loudness.
 * Joined raw, the show has long dead air between turns and one host louder than the
 * other. So each line is trimmed to its sound, faded at both ends against clicks,
 * scaled by one gain per host, and separated by a short gap; a final peak guard keeps
 * the sum below full scale. 16-bit little-endian mono PCM throughout.
 */

export interface MixLine {
  pcm: Buffer;
  /** Lines with the same speaker share one gain. */
  speaker: string;
  /** Leave out of the host's level measurement (whispers), so it stays quieter. */
  keepDynamics?: boolean;
}

export interface MixOptions {
  sampleRate: number;
  /** Silence between lines. Default 200 ms. */
  gapMs?: number;
  /** Fade in and out at each line's edges. Default 8 ms. */
  fadeMs?: number;
  /** Audio kept beyond the first and last sound of a line, so soft onsets survive. Default 40 ms. */
  edgeMs?: number;
  /** A 10 ms window quieter than this (dBFS) counts as silence. Default -45. */
  silenceDb?: number;
  /** Largest boost or cut applied to a host. Default 6 dB. */
  maxGainDb?: number;
  /** Peak limit as a fraction of full scale. Default 0.95. */
  peakCeiling?: number;
}

const FULL_SCALE = 32767;
const WINDOW_MS = 10;

const sampleCount = (pcm: Buffer) => pcm.length >> 1;
const windowSize = (sampleRate: number) => Math.max(1, Math.round((sampleRate * WINDOW_MS) / 1000));
const thresholdFor = (silenceDb: number) => FULL_SCALE * 10 ** (silenceDb / 20);

/** Calls fn for each 10 ms window with its start, end and sum of squares. */
function forEachWindow(pcm: Buffer, sampleRate: number, fn: (start: number, end: number, sumSq: number) => void): void {
  const total = sampleCount(pcm);
  const size = windowSize(sampleRate);
  for (let start = 0; start < total; start += size) {
    const end = Math.min(total, start + size);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * 2);
      sumSq += v * v;
    }
    fn(start, end, sumSq);
  }
}

/** The line from its first to its last audible window, plus edgeMs each side. Empty if silent. */
export function trimSilence(pcm: Buffer, sampleRate: number, silenceDb = -45, edgeMs = 40): Buffer {
  const threshold = thresholdFor(silenceDb);
  let first = -1;
  let last = -1;
  forEachWindow(pcm, sampleRate, (start, end, sumSq) => {
    if (Math.sqrt(sumSq / (end - start)) >= threshold) {
      if (first < 0) first = start;
      last = end;
    }
  });
  if (first < 0) return pcm.subarray(0, 0);
  const edge = Math.round((sampleRate * edgeMs) / 1000);
  const from = Math.max(0, first - edge);
  const to = Math.min(sampleCount(pcm), last + edge);
  return pcm.subarray(from * 2, to * 2);
}

/** RMS over audible windows only, so pauses inside a line don't drag its level down. */
export function activeRms(pcm: Buffer, sampleRate: number, silenceDb = -45): number {
  const { sumSq, n } = activeEnergy(pcm, sampleRate, silenceDb);
  return n ? Math.sqrt(sumSq / n) : 0;
}

function activeEnergy(pcm: Buffer, sampleRate: number, silenceDb: number): { sumSq: number; n: number } {
  const threshold = thresholdFor(silenceDb);
  let total = 0;
  let n = 0;
  forEachWindow(pcm, sampleRate, (start, end, sumSq) => {
    if (Math.sqrt(sumSq / (end - start)) >= threshold) {
      total += sumSq;
      n += end - start;
    }
  });
  return { sumSq: total, n };
}

export function mixDialogue(lines: MixLine[], options: MixOptions): Buffer {
  const { sampleRate } = options;
  const gapMs = options.gapMs ?? 200;
  const fadeMs = options.fadeMs ?? 8;
  const edgeMs = options.edgeMs ?? 40;
  const silenceDb = options.silenceDb ?? -45;
  const maxGainDb = options.maxGainDb ?? 6;
  const peakCeiling = options.peakCeiling ?? 0.95;

  const trimmed = lines
    .map(line => ({ ...line, pcm: trimSilence(line.pcm, sampleRate, silenceDb, edgeMs) }))
    .filter(line => sampleCount(line.pcm) > 0);
  if (!trimmed.length) throw new Error('Dialogue has no audible lines');

  // One gain per speaker, measured on that speaker's normal lines only, toward the
  // mean level of all speakers.
  const energy = new Map<string, { sumSq: number; n: number }>();
  for (const line of trimmed) {
    if (line.keepDynamics) continue;
    const e = activeEnergy(line.pcm, sampleRate, silenceDb);
    const acc = energy.get(line.speaker) ?? { sumSq: 0, n: 0 };
    acc.sumSq += e.sumSq;
    acc.n += e.n;
    energy.set(line.speaker, acc);
  }
  const levels = new Map<string, number>();
  for (const [speaker, e] of energy) if (e.n) levels.set(speaker, Math.sqrt(e.sumSq / e.n));
  const target = levels.size ? [...levels.values()].reduce((s, v) => s + v, 0) / levels.size : 0;
  const maxGain = 10 ** (maxGainDb / 20);
  const gainOf = (speaker: string): number => {
    const level = levels.get(speaker);
    if (!level || !target) return 1;
    return Math.min(maxGain, Math.max(1 / maxGain, target / level));
  };

  const gap = Math.round((sampleRate * gapMs) / 1000);
  const total = trimmed.reduce((sum, line) => sum + sampleCount(line.pcm), 0) + gap * (trimmed.length - 1);
  const mixed = new Float64Array(total);
  let pos = 0;
  trimmed.forEach((line, index) => {
    if (index > 0) pos += gap;
    const n = sampleCount(line.pcm);
    const gain = gainOf(line.speaker);
    const fade = Math.min(Math.round((sampleRate * fadeMs) / 1000), n >> 1);
    for (let k = 0; k < n; k++) {
      let v = line.pcm.readInt16LE(k * 2) * gain;
      if (fade > 0 && k < fade) v *= k / fade;
      else if (fade > 0 && k >= n - fade) v *= (n - 1 - k) / fade;
      mixed[pos + k] = v;
    }
    pos += n;
  });

  let peak = 0;
  for (let k = 0; k < total; k++) peak = Math.max(peak, Math.abs(mixed[k]));
  const ceiling = FULL_SCALE * peakCeiling;
  const scale = peak > ceiling ? ceiling / peak : 1;

  const out = Buffer.alloc(total * 2);
  for (let k = 0; k < total; k++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mixed[k] * scale))), k * 2);
  }
  return out;
}
