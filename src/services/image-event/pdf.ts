/**
 * PDF preparation for the invitation reader.
 * Gemini reads PDFs natively (text and scanned page images), but a long PDF costs a lot
 * of tokens and time, so only the first MAX_PDF_PAGES pages are sent.
 *
 * A PDF with an owner password only (restricted editing/printing, e-tickets, bank and
 * government forms) opens without a password and Gemini reads it, so it is sent as it is.
 * pdf-lib cannot copy pages out of an encrypted file (they would come out unreadable), so
 * such a PDF is never trimmed; Telegram's 20 MB download limit bounds its size. A PDF that
 * needs a password to open is refused.
 */

import { createCipheriv, createHash } from 'node:crypto';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from 'pdf-lib';

/** Pages sent to Gemini; the rest are dropped and the user is told. */
export const MAX_PDF_PAGES = 20;

/** The PDF could not be opened: needs a password, damaged, or not a PDF at all. */
export class PdfUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`PDF could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PdfUnreadableError';
    this.cause = cause;
  }
}

export interface PreparedPdf {
  buffer: Buffer;
  /** Pages in the file, or 0 when an encrypted file's page tree cannot be read (it is sent whole anyway). */
  totalPages: number;
  keptPages: number;
}

/**
 * Opens the PDF to count its pages (this also rejects broken files) and, when it has more
 * than MAX_PDF_PAGES, returns a copy of its first MAX_PDF_PAGES pages. A PDF within the
 * limit, and an encrypted one that opens without a password, is returned untouched.
 * @throws PdfUnreadableError
 */
export async function preparePdf(input: Buffer): Promise<PreparedPdf> {
  let source: PDFDocument;
  try {
    // Without ignoreEncryption pdf-lib refuses every encrypted file, also one that opens
    // without a password. The flag is only a way to read the structure here.
    source = await PDFDocument.load(input, { ignoreEncryption: true });
  } catch (error) {
    throw new PdfUnreadableError(error);
  }
  if (source.isEncrypted) return prepareEncrypted(input, source);

  const totalPages = source.getPageCount();
  if (totalPages === 0) throw new PdfUnreadableError(new Error('the PDF has no pages'));
  if (totalPages <= MAX_PDF_PAGES) return { buffer: input, totalPages, keptPages: totalPages };

  try {
    const trimmed = await PDFDocument.create();
    const pages = await trimmed.copyPages(source, Array.from({ length: MAX_PDF_PAGES }, (_, i) => i));
    pages.forEach(page => trimmed.addPage(page));
    return { buffer: Buffer.from(await trimmed.save()), totalPages, keptPages: MAX_PDF_PAGES };
  } catch (error) {
    throw new PdfUnreadableError(error);
  }
}

/** An encrypted PDF: sent whole when the empty password opens it, refused otherwise. */
function prepareEncrypted(input: Buffer, doc: PDFDocument): PreparedPdf {
  let opens: boolean;
  try {
    opens = opensWithEmptyPassword(doc);
  } catch (error) {
    throw new PdfUnreadableError(error);
  }
  if (!opens) throw new PdfUnreadableError(new Error('the PDF needs a password to open'));

  let pages = 0;
  try {
    pages = doc.getPageCount();
  } catch (error) {
    // Not needed: an encrypted file goes to Gemini as it is. Only the page count is lost.
    console.warn('[Image] Could not count the pages of an encrypted PDF:', error);
  }
  return { buffer: input, totalPages: pages, keptPages: pages };
}

// ---- Does the empty (user) password open the file? PDF 32000-1, 7.6.3 ----

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();

/** RC4 by hand: Node's OpenSSL 3 no longer offers it. */
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

function bytesOf(value: unknown, what: string): Buffer {
  if (value instanceof PDFHexString || value instanceof PDFString) return Buffer.from(value.asBytes());
  throw new Error(`the encryption dictionary has no usable ${what}`);
}

function encryptAesCbc(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** Revision 6 hash (ISO 32000-2, algorithm 2.B) of the empty password plus a salt. */
function hashR6(salt: Buffer): Buffer {
  let k = createHash('sha256').update(salt).digest();
  for (let round = 0; ; round++) {
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => k));
    const e = encryptAesCbc(k.subarray(0, 16), k.subarray(16, 32), k1);
    const mod = e.subarray(0, 16).reduce((sum, b) => sum + b, 0) % 3;
    k = createHash(['sha256', 'sha384', 'sha512'][mod]).update(e).digest();
    if (round >= 63 && e[e.length - 1] <= round - 32) return k.subarray(0, 32);
  }
}

/** @throws when the encryption dictionary is not a standard one this can check. */
function opensWithEmptyPassword(doc: PDFDocument): boolean {
  const ctx = doc.context;
  const entry = ctx.trailerInfo.Encrypt;
  const encrypt = entry instanceof PDFRef ? ctx.lookup(entry) : entry;
  if (!(encrypt instanceof PDFDict)) throw new Error('no encryption dictionary');
  const filter = encrypt.get(PDFName.of('Filter'));
  if (!(filter instanceof PDFName) || filter.asString() !== '/Standard') throw new Error('not the standard security handler');

  const num = (name: string): number | undefined => {
    const v = encrypt.get(PDFName.of(name));
    return v instanceof PDFNumber ? v.asNumber() : undefined;
  };
  const revision = num('R');
  if (revision === undefined) throw new Error('the encryption dictionary has no revision');
  const o = bytesOf(encrypt.get(PDFName.of('O')), 'O');
  const u = bytesOf(encrypt.get(PDFName.of('U')), 'U');

  if (revision >= 5) {
    // AES-256: U is hash(32) + validation salt(8) + key salt(8). R5 is a plain SHA-256.
    if (u.length < 48) throw new Error('U is too short');
    const validationSalt = u.subarray(32, 40);
    const hash = revision === 5 ? createHash('sha256').update(validationSalt).digest() : hashR6(validationSalt);
    return hash.equals(u.subarray(0, 32));
  }

  if (revision < 2 || o.length < 32 || u.length < 16) throw new Error('unsupported encryption revision');
  const permissions = num('P');
  if (permissions === undefined) throw new Error('the encryption dictionary has no permissions');
  const idArray = ctx.trailerInfo.ID;
  const idEntry = idArray instanceof PDFArray ? idArray.get(0) : undefined;
  const id0 = idEntry instanceof PDFHexString || idEntry instanceof PDFString ? Buffer.from(idEntry.asBytes()) : Buffer.alloc(0);
  const keyBytes = revision === 2 ? 5 : Math.floor((num('Length') ?? (num('V') === 4 ? 128 : 40)) / 8);
  const metaEntry = encrypt.get(PDFName.of('EncryptMetadata'));
  const encryptMetadata = metaEntry instanceof PDFBool ? metaEntry.asBoolean() : true;

  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions | 0);
  let key = md5(PAD, o.subarray(0, 32), p, id0, revision >= 4 && !encryptMetadata ? Buffer.alloc(4, 0xff) : Buffer.alloc(0));
  if (revision >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, keyBytes));
  key = key.subarray(0, keyBytes);

  if (revision === 2) return rc4(key, PAD).equals(u.subarray(0, 32));
  let x = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(key.map(b => b ^ i)), x);
  return x.equals(u.subarray(0, 16));
}
