import { extractText, getDocumentProxy } from 'unpdf';
import { logger } from 'firebase-functions';
import { joinPages, type OcrExtraction, type OcrPage } from './types.js';

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
 */
const MIN_CHARS_PER_PAGE = 100;

export interface PdfProbe {
  pageCount: number;
  extraction: OcrExtraction | null;
}

/**
 * Returns the page count always, and an extraction only if the text layer is real.
 * A null extraction means "this is a scan — send it to Vision".
 */
export async function extractPdfTextLayer(bytes: Uint8Array): Promise<PdfProbe> {
  const pdf = await getDocumentProxy(bytes);
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
  const enough = totalPages > 0 && chars / totalPages >= MIN_CHARS_PER_PAGE;

  logger.debug('pdf text layer probe', {
    totalPages,
    chars,
    perPage: totalPages ? Math.round(chars / totalPages) : 0,
    enough,
  });

  if (!enough) return { pageCount: totalPages, extraction: null };

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
