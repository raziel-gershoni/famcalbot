/**
 * PDF preparation for the invitation reader.
 * Gemini reads PDFs natively (text and scanned page images), but a long PDF costs a lot
 * of tokens and time, so only the first MAX_PDF_PAGES pages are sent.
 *
 * A PDF with an owner password only (restricted editing/printing, e-tickets, bank and
 * government forms) opens without a password and Gemini reads it, so it is sent as it is.
 * pdf-lib cannot copy pages out of an encrypted file (they would come out unreadable), so
 * such a PDF is never trimmed; Telegram's 20 MB download limit bounds its size. If Gemini
 * cannot read it (it needs a password), the handler says so.
 */

import { PDFDocument } from 'pdf-lib';

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
  /** Pages in the file; 0 for an encrypted file (not counted). */
  totalPages: number;
  keptPages: number;
  /** Encrypted: sent untouched, and may still be unreadable to Gemini. */
  encrypted?: boolean;
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
  if (source.isEncrypted) {
    // pdf-lib cannot read or copy the pages of an encrypted file, and cannot tell an
    // owner-password-only file (opens freely) from one that needs a password. Send the
    // original bytes; Gemini's answer decides (the handler replies "can't open" if it refuses).
    return { buffer: input, totalPages: 0, keptPages: 0, encrypted: true };
  }

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
