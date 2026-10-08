/**
 * Acoustic loudness of a voice note - pure, no network, no model.
 *
 * Kept apart from the model-based speech gate (./speech-presence) so it can be tested
 * without pulling in the AI provider's import chain.
 */

import OpusScript from 'opusscript';

/**
 * Loudness at or below which a note is treated as silence. Real speech in the test
 * corpus sat at -15 to -22 dBFS RMS (-22 with heavy background noise), and a TV in
 * the background at -35. Silence, room tone and an accidental tap measured -inf,
 * -67 and -56. -50 leaves ~15 dB of headroom below the quietest speech seen.
 */
export const SILENCE_THRESHOLD_DBFS = -50;

const OPUS_RATE = 48_000;

/**
 * RMS loudness of an OGG Opus clip in dBFS, or null when it cannot be measured.
 * -Infinity means digital silence. Uses the Opus decoder already shipped for TTS,
 * so there is no ffmpeg dependency at runtime.
 */
export function measureLoudnessDbfs(ogg: Buffer): number | null {
  let packets: Buffer[];
  try {
    packets = readOggPackets(ogg);
  } catch {
    return null;
  }

  const head = packets[0];
  if (!head || head.toString('ascii', 0, 8) !== 'OpusHead') return null;
  const channels = head.readUInt8(9) || 1;

  let decoder: OpusScript | null = null;
  try {
    decoder = new OpusScript(OPUS_RATE, channels, OpusScript.Application.VOIP);
    let sumSquares = 0;
    let count = 0;
    for (const packet of packets.slice(1)) {
      // The second packet is OpusTags metadata, not audio.
      if (packet.length >= 8 && packet.toString('ascii', 0, 8) === 'OpusTags') continue;
      const pcm = decoder.decode(packet);
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i);
        sumSquares += sample * sample;
        count++;
      }
    }
    if (count === 0) return null;
    const rms = Math.sqrt(sumSquares / count);
    return rms === 0 ? -Infinity : 20 * Math.log10(rms / 32768);
  } catch {
    return null;
  } finally {
    decoder?.delete();
  }
}

/** True only when the clip is measurably quiet. Unmeasurable audio is not silent. */
export function isSilent(ogg: Buffer): boolean {
  const level = measureLoudnessDbfs(ogg);
  return level !== null && level <= SILENCE_THRESHOLD_DBFS;
}

/**
 * Split an OGG stream into its logical packets.
 *
 * Each page carries a segment table; a packet is the run of segments up to the first
 * one shorter than 255 bytes, and may continue onto the next page.
 */
function readOggPackets(ogg: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let pending: Buffer[] = [];
  let offset = 0;

  while (offset + 27 <= ogg.length) {
    if (ogg.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new Error(`No OGG page at byte ${offset}`);
    }
    const segments = ogg.readUInt8(offset + 26);
    const table = ogg.subarray(offset + 27, offset + 27 + segments);
    let cursor = offset + 27 + segments;

    for (const size of table) {
      pending.push(ogg.subarray(cursor, cursor + size));
      cursor += size;
      if (size < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    offset = cursor;
  }

  return packets;
}
