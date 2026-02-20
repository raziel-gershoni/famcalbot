/**
 * PCM → OGG OPUS converter
 * Converts raw PCM audio (24kHz, 16-bit LE, mono) to OGG OPUS format for Telegram voice messages.
 * Uses opusscript (WASM) for Opus encoding + pure-JS OGG container muxer.
 *
 * References:
 * - RFC 7845: Ogg Encapsulation for Opus (https://www.rfc-editor.org/rfc/rfc7845)
 * - Xiph OGG framing spec (https://xiph.org/ogg/doc/framing.html)
 */

import OpusScript from 'opusscript';
import { randomBytes } from 'crypto';

// Audio format constants (Gemini TTS output: 24kHz, 16-bit LE, mono)
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const FRAME_SIZE = 480; // 20ms at 24kHz
const BYTES_PER_FRAME = FRAME_SIZE * CHANNELS * 2; // 960 bytes per frame (16-bit = 2 bytes per sample)

// RFC 7845: granule position is always in 48kHz units regardless of input sample rate
const GRANULE_PER_FRAME = 960; // 20ms × 48000 / 1000

// Opus pre-skip: codec delay in 48kHz units (standard for Opus encoder)
const PRE_SKIP = 3840; // 80ms × 48000 / 1000

// ─── CRC32 (OGG uses reflected polynomial 0xEDB88320, LSB-first) ───

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
  }
  CRC32_TABLE[i] = crc >>> 0;
}

function oggCrc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── OGG Page Builder ───

function buildOggPage(
  serialNo: number,
  pageSeqNo: number,
  granulePos: number,
  headerType: number,
  segments: Buffer[]
): Buffer {
  // Build OGG lacing table: segments > 255 bytes need multiple lacing values
  const lacingValues: number[] = [];
  for (const segment of segments) {
    let remaining = segment.length;
    while (remaining >= 255) {
      lacingValues.push(255);
      remaining -= 255;
    }
    lacingValues.push(remaining);
  }

  const headerSize = 27 + lacingValues.length;
  const bodySize = segments.reduce((sum, s) => sum + s.length, 0);
  const page = Buffer.alloc(headerSize + bodySize);

  // OGG page header
  page.write('OggS', 0);                          // Capture pattern
  page.writeUInt8(0, 4);                           // Version
  page.writeUInt8(headerType, 5);                  // Header type flags
  // Granule position (64-bit LE) — write as two 32-bit values
  page.writeUInt32LE(granulePos & 0xFFFFFFFF, 6);
  page.writeUInt32LE(Math.floor(granulePos / 0x100000000), 10);
  page.writeUInt32LE(serialNo, 14);                // Serial number
  page.writeUInt32LE(pageSeqNo, 18);               // Page sequence number
  page.writeUInt32LE(0, 22);                       // CRC32 placeholder (zeroed)
  page.writeUInt8(lacingValues.length, 26);        // Segment count

  // Segment table (lacing values)
  for (let i = 0; i < lacingValues.length; i++) {
    page.writeUInt8(lacingValues[i], 27 + i);
  }

  // Body (concatenated segments)
  let offset = headerSize;
  for (const segment of segments) {
    segment.copy(page, offset);
    offset += segment.length;
  }

  // Compute CRC32 over the entire page and write it
  const crc = oggCrc32(page);
  page.writeUInt32LE(crc, 22);

  return page;
}

// ─── OpusHead and OpusTags ───

function buildOpusHead(): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0);                       // Magic signature
  head.writeUInt8(1, 8);                           // Version
  head.writeUInt8(CHANNELS, 9);                    // Channel count
  head.writeUInt16LE(PRE_SKIP, 10);               // Pre-skip
  head.writeUInt32LE(SAMPLE_RATE, 12);            // Input sample rate (informational)
  head.writeInt16LE(0, 16);                        // Output gain
  head.writeUInt8(0, 18);                          // Channel mapping family
  return head;
}

function buildOpusTags(): Buffer {
  const vendor = 'famcalbot';
  const vendorBuf = Buffer.from(vendor, 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendorBuf.length + 4);
  tags.write('OpusTags', 0);                       // Magic signature
  tags.writeUInt32LE(vendorBuf.length, 8);        // Vendor string length
  vendorBuf.copy(tags, 12);                        // Vendor string
  tags.writeUInt32LE(0, 12 + vendorBuf.length);   // Comment count (0)
  return tags;
}

// ─── Main Encoder ───

/**
 * Encode raw PCM audio (24kHz, 16-bit LE, mono) to OGG OPUS format.
 * This is the ONLY place where PCM frame boundary truncation happens.
 * Callers should pass raw PCM directly without pre-truncation.
 */
export function encodePcmToOggOpus(pcmBuffer: Buffer): Buffer {
  // Truncate to nearest frame boundary
  const truncatedLength = Math.floor(pcmBuffer.length / BYTES_PER_FRAME) * BYTES_PER_FRAME;
  if (truncatedLength === 0) {
    throw new Error('PCM buffer too small to contain a single frame');
  }
  pcmBuffer = pcmBuffer.subarray(0, truncatedLength);

  const serialNo = randomBytes(4).readUInt32LE(0);
  const pages: Buffer[] = [];

  // Page 0: OpusHead (beginning of stream)
  pages.push(buildOggPage(serialNo, 0, 0, 0x02, [buildOpusHead()]));

  // Page 1: OpusTags
  pages.push(buildOggPage(serialNo, 1, 0, 0x00, [buildOpusTags()]));

  // Encode audio frames
  const encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  try {
    const totalFrames = pcmBuffer.length / BYTES_PER_FRAME;
    let granulePos = 0;
    let pageSeqNo = 2;
    let frameSegments: Buffer[] = [];

    for (let i = 0; i < totalFrames; i++) {
      const chunk = pcmBuffer.subarray(i * BYTES_PER_FRAME, (i + 1) * BYTES_PER_FRAME);
      // Pass chunk directly — do NOT use Buffer.from(chunk.buffer) as .buffer
      // returns the full underlying ArrayBuffer, not the subarray slice
      const encoded = Buffer.from(encoder.encode(chunk, FRAME_SIZE));
      frameSegments.push(encoded);
      granulePos += GRANULE_PER_FRAME;

      const isLastFrame = i === totalFrames - 1;

      // Batch ~48 frames per page, or flush on last frame
      if (frameSegments.length >= 48 || isLastFrame) {
        const headerType = isLastFrame ? 0x04 : 0x00; // 0x04 = end of stream
        pages.push(buildOggPage(serialNo, pageSeqNo++, granulePos, headerType, frameSegments));
        frameSegments = [];
      }
    }
  } finally {
    encoder.delete(); // Always free WASM memory
  }

  return Buffer.concat(pages);
}
