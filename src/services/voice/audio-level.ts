/**
 * Acoustic loudness of a voice note - pure, no network, no model.
 *
 * Kept apart from the model-based speech gate (./speech-presence) so it can be tested
 * without pulling in the AI provider's import chain.
 */

import OpusScript from 'opusscript';

/**
 * Level of the loudest window at or below which a note is treated as silence.
 *
 * Measured on the loudest 500 ms window, not the whole clip: an average is diluted
 * by the silence around a short command, so a quiet 2 s command inside a 15 s note
 * averaged -52 to -54 dBFS and was dropped as silent even though the speech itself
 * sat at -42 to -44. Near-silent non-speech measures the same either way - digital
 * silence -inf, room tone -66, an accidental tap -56 - so -50 rejects all of those
 * while leaving ~6 dB of headroom above the quietest real speech measured.
 *
 * Errors in this gate only ever fall towards "not silent": a phone whose AGC lifts
 * room tone above the threshold just leaves the decision to the model-based gate.
 */
export const SILENCE_THRESHOLD_DBFS = -50;

/**
 * Longest stretch of audio decoded before giving up. Decoding is synchronous on the
 * single process that also serves every webhook and cron job, and WhatsApp notes have
 * no length limit, so the work must be bounded. Speech stops the decode within its
 * first loud half-second; this cap only matters for long quiet recordings, which are
 * then reported as unmeasurable and left to the model-based gate.
 */
export const MAX_MEASURED_SECONDS = 120;

const OPUS_RATE = 48_000;
const WINDOW_MS = 500;
const HOP_MS = 250;

export interface LoudnessOptions {
  /** Stop as soon as a window is louder than this; the result is then a lower bound. */
  stopAboveDbfs?: number;
  /** Decode at most this many seconds; longer audio returns null. */
  maxSeconds?: number;
}

/**
 * RMS level of the loudest 500 ms window of an OGG Opus clip, in dBFS. -Infinity is
 * digital silence. null means it could not be measured - not Opus, corrupt, or longer
 * than maxSeconds without an early stop - and callers must treat that as "not silent".
 * Uses the Opus decoder already shipped for TTS, so there is no ffmpeg at runtime.
 */
export function loudestWindowDbfs(ogg: Buffer, opts: LoudnessOptions = {}): number | null {
  const maxSamples = (opts.maxSeconds ?? MAX_MEASURED_SECONDS) * OPUS_RATE;
  const hopLength = (OPUS_RATE * HOP_MS) / 1000;

  let decoder: OpusScript | null = null;
  try {
    const packets = oggPackets(ogg);
    const head = packets.next();
    if (head.done || head.value.toString('ascii', 0, 8) !== 'OpusHead') return null;
    const channels = head.value.readUInt8(9) || 1;
    decoder = new OpusScript(OPUS_RATE, channels, OpusScript.Application.VOIP);

    // Energy is accumulated per 250 ms hop; a window is two consecutive hops.
    let hopEnergy = 0;
    let hopCount = 0;
    let prevEnergy = 0;
    let prevCount = 0;
    let loudest = -Infinity; // mean square of the loudest window seen
    let samplesPerChannel = 0;

    const closeHop = () => {
      const meanSquare = (prevEnergy + hopEnergy) / (prevCount + hopCount);
      if (meanSquare > loudest) loudest = meanSquare;
      prevEnergy = hopEnergy;
      prevCount = hopCount;
      hopEnergy = 0;
      hopCount = 0;
    };

    for (const packet of packets) {
      // The second packet is OpusTags metadata, not audio.
      if (packet.length >= 8 && packet.toString('ascii', 0, 8) === 'OpusTags') continue;

      const pcm = decoder.decode(packet);
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i);
        hopEnergy += sample * sample;
        hopCount++;
        if (hopCount >= hopLength * channels) {
          closeHop();
          if (opts.stopAboveDbfs !== undefined && toDbfs(loudest) > opts.stopAboveDbfs) {
            return toDbfs(loudest);
          }
        }
      }

      samplesPerChannel += pcm.length / 2 / channels;
      if (samplesPerChannel > maxSamples) return null;
    }

    if (hopCount > 0) closeHop();
    if (prevCount === 0 && loudest === -Infinity) return null; // no audio at all
    return toDbfs(loudest);
  } catch {
    return null;
  } finally {
    decoder?.delete();
  }
}

/** True only when the clip is measurably quiet. Unmeasurable audio is not silent. */
export function isSilent(ogg: Buffer): boolean {
  // Stop at the first window louder than the threshold - for speech that is within
  // its first second, so a normal voice note costs almost nothing to check.
  const level = loudestWindowDbfs(ogg, { stopAboveDbfs: SILENCE_THRESHOLD_DBFS });
  return level !== null && level <= SILENCE_THRESHOLD_DBFS;
}

function toDbfs(meanSquare: number): number {
  return meanSquare > 0 ? 10 * Math.log10(meanSquare / (32768 * 32768)) : -Infinity;
}

/**
 * Yield an OGG stream's logical packets one at a time, without materialising them all.
 *
 * Each page carries a segment table; a packet is the run of segments up to the first
 * one shorter than 255 bytes, and may continue onto the next page.
 */
function* oggPackets(ogg: Buffer): Generator<Buffer> {
  let pending: Buffer[] = [];
  let offset = 0;

  while (offset + 27 <= ogg.length) {
    if (ogg.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new Error(`No OGG page at byte ${offset}`);
    }
    const segments = ogg.readUInt8(offset + 26);
    const tableStart = offset + 27;
    if (tableStart + segments > ogg.length) throw new Error('Truncated OGG page header');

    let cursor = tableStart + segments;
    for (let s = 0; s < segments; s++) {
      const size = ogg[tableStart + s];
      if (cursor + size > ogg.length) throw new Error('Truncated OGG page body');
      pending.push(ogg.subarray(cursor, cursor + size));
      cursor += size;
      if (size < 255) {
        yield pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending = [];
      }
    }
    offset = cursor;
  }
}
