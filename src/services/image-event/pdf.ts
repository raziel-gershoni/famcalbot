/**
 * PDF preparation for the invitation reader.
 * Gemini reads PDFs natively (text and scanned page images), but a long PDF costs a lot
 * of tokens and time, so only the first MAX_PDF_PAGES pages are sent.
 */

import { PDFDocument } from 'pdf-lib';

/** Pages sent to Gemini; the rest are dropped and the user is told. */
export const MAX_PDF_PAGES = 20;

/** The PDF could not be opened: password-protected, damaged, or not a PDF at all. */
export class PdfUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`PDF could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PdfUnreadableError';
    this.cause = cause;
  }
}

export interface PreparedPdf {
  buffer: Buffer;
  totalPages: number;
  keptPages: number;
}

/**
 * Opens the PDF to count its pages (this also rejects encrypted and broken files) and, when
 * it has more than MAX_PDF_PAGES, returns a copy of its first MAX_PDF_PAGES pages. A PDF
 * within the limit is returned untouched.
 * @throws PdfUnreadableError
 */
export async function preparePdf(input: Buffer): Promise<PreparedPdf> {
  let source: PDFDocument;
  try {
    // pdf-lib refuses encrypted files unless told to ignore the encryption (which would
    // yield unreadable pages), so a password-protected PDF lands here as an error.
    source = await PDFDocument.load(input);
  } catch (error) {
    throw new PdfUnreadableError(error);
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
