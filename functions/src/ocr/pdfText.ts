import { extractText, getDocumentProxy } from 'unpdf';
import { logger } from 'firebase-functions';
import { joinPages, type OcrExtraction, type OcrPage } from './types.js';
import { looksScanned, surveyImages } from './pdfImages.js';

/**
 * The free path: pull the existing text layer out of a digital-native PDF.
 *
 * Most PDFs a CPA firm receives — supplier invoices, bank statements, anything printed
 * from software rather than scanned — already carry their text. Reading it is instant
 * and costs nothing, against roughly $1.50 per 1000 pages for Vision. This is tried
 * FIRST for every PDF, and only a real scan falls through to OCR.
 *
 * unpdf rather than pdf-parse: pdf-parse 1.x executes bundled test code when imported
 * outside CommonJS, which breaks under an ESM Functions runtime. unpdf is a serverless
 * -oriented pdfjs wrapper with no native dependencies.
 */

/**
 * Below this, the "text layer" is almost certainly incidental — a scanner's cover page
 * or a stray watermark on an otherwise image-only document. Treating that as a
 * successful extraction would leave the real content unsearchable and nobody would
 * know, which is worse than paying for OCR.
 *
 * This is a floor, not the whole test. See the image survey below: a character count
 * alone cannot tell a sparse invoice from a scan wrapped in boilerplate, and it was
 * this threshold passing at 148 characters that lost a real receipt.
 */
const MIN_CHARS_PER_PAGE = 100;

export interface PdfProbe {
  pageCount: number;
  extraction: OcrExtraction | null;
  /** Why the text layer was rejected, when it was. For logs and for tests. */
  reason?: 'scanned' | 'too-little-text';
}

/**
 * Returns the page count always, and an extraction only if the text layer is real.
 * A null extraction means "this is a scan — send it to Vision".
 */
export async function extractPdfTextLayer(bytes: Uint8Array): Promise<PdfProbe> {
  // pdfjs REJECTS a Node Buffer outright — "Please provide binary data as Uint8Array,
  // rather than Buffer" — even though Buffer extends Uint8Array. Storage downloads
  // return Buffers, so normalising here is the difference between working in
  // production and only working in tests, where fixtures arrive as plain Uint8Arrays.
  // Buffer.from(...).buffer would share memory with the pool; this copies the view.
  const data = Buffer.isBuffer(bytes) ? new Uint8Array(bytes) : bytes;

  const pdf = await getDocumentProxy(data);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const perPage: string[] = Array.isArray(text) ? text : [text];

  const pages: OcrPage[] = perPage.map((t, i) => ({
    pageNumber: i + 1,
    text: (t ?? '').trim(),
    // A text layer is extracted, not recognised — there is no confidence to report,
    // and inventing 1.0 would make a scan and a native PDF indistinguishable later.
    confidence: null,
    width: null,
    height: null,
  }));

  const fullText = joinPages(pages);
  const chars = fullText.length;

  // Does the document carry a scanned page? If so the text layer describes at most a
  // wrapper around it, and trusting it silently discards the actual document. This
  // check comes FIRST and overrides the character count, because the failing case had
  // plenty of characters — they were just the wrong ones.
  const survey = await surveyImages(pdf).catch((err: unknown) => {
    // Never let a survey failure block extraction: a missing survey degrades to the
    // old character-count behaviour rather than failing the document outright.
    logger.warn('pdf image survey failed', { err: String(err) });
    return { maxImagePixels: 0, imageCount: 0 };
  });

  const scanned = looksScanned(survey);
  const enoughText = totalPages > 0 && chars / totalPages >= MIN_CHARS_PER_PAGE;

  logger.debug('pdf text layer probe', {
    totalPages,
    chars,
    perPage: totalPages ? Math.round(chars / totalPages) : 0,
    maxImagePixels: survey.maxImagePixels,
    imageCount: survey.imageCount,
    scanned,
    enoughText,
  });

  if (scanned) {
    logger.info('pdf carries a scanned page — sending to Vision despite its text layer', {
      chars,
      maxImagePixels: survey.maxImagePixels,
    });
    return { pageCount: totalPages, extraction: null, reason: 'scanned' };
  }

  if (!enoughText) {
    return { pageCount: totalPages, extraction: null, reason: 'too-little-text' };
  }

  return {
    pageCount: totalPages,
    extraction: {
      engine: 'pdf-parse',
      method: 'pdfTextLayer',
      pages,
      fullText,
      avgConfidence: null,
      languageCodes: [],
    },
  };
}
