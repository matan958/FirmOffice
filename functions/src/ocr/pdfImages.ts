import { getResolvedPDFJS } from 'unpdf';

/**
 * How much raster image a PDF page carries.
 *
 * This exists because a character count cannot tell a digital invoice from a scan.
 * Israeli digital-receipt providers (Weezmo and similar) wrap a photographed receipt
 * in a PDF that carries its own small text layer — a legal notice, a page number, a
 * support URL — and nothing else. That layer is real text, comfortably over any
 * sensible per-page character threshold, and it describes none of the document. The
 * pipeline read one of those as "digital-native, no OCR needed" and stored 148
 * characters of boilerplate as the entire content of a receipt.
 *
 * The image is the evidence that settles it. Measured against real files:
 *
 *   Weezmo receipt (a scan)        3 images   largest 893,580 px   148 chars
 *   digital invoice with logos     4 images   largest  13,446 px   651 chars
 *   plain digital invoice          0 images        —               501 chars
 *
 * A logo is tens of thousands of pixels; a scanned page is hundreds of thousands.
 * The gap is two orders of magnitude, so the threshold does not need to be clever.
 */

/**
 * 500×500. Eighteen times the largest logo observed, three and a half times below the
 * smallest scan observed. Anything at or above this is a photograph or a scanned page,
 * not decoration.
 */
export const LARGE_IMAGE_MIN_PIXELS = 250_000;

export interface ImageSurvey {
  /** Pixel count of the biggest raster image anywhere in the document. */
  maxImagePixels: number;
  imageCount: number;
}

/**
 * `pdf` is a pdfjs PDFDocumentProxy, kept untyped here because unpdf does not export
 * the type and structurally typing it would pin us to a pdfjs version.
 */
export async function surveyImages(pdf: {
  numPages: number;
  getPage(n: number): Promise<{
    getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  }>;
}): Promise<ImageSurvey> {
  const { OPS } = await getResolvedPDFJS();

  const imageOps = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      // Older pdfjs builds emit this separately; harmless when undefined.
      (OPS as Record<string, number | undefined>)['paintJpegXObject'],
    ].filter((v): v is number => typeof v === 'number'),
  );

  let maxImagePixels = 0;
  let imageCount = 0;

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const ops = await page.getOperatorList();

    for (let i = 0; i < ops.fnArray.length; i++) {
      if (!imageOps.has(ops.fnArray[i]!)) continue;
      imageCount++;

      // paintImageXObject args are [objId, width, height]; inline images arrive as a
      // single object carrying width/height. Both forms are handled because a PDF may
      // contain either, and missing one would silently under-report.
      const args = ops.argsArray[i] as
        | [unknown, number?, number?]
        | { width?: number; height?: number }
        | undefined;

      let width: number | undefined;
      let height: number | undefined;

      if (Array.isArray(args)) {
        width = typeof args[1] === 'number' ? args[1] : undefined;
        height = typeof args[2] === 'number' ? args[2] : undefined;
      } else if (args && typeof args === 'object') {
        width = typeof args.width === 'number' ? args.width : undefined;
        height = typeof args.height === 'number' ? args.height : undefined;
      }

      if (width !== undefined && height !== undefined) {
        maxImagePixels = Math.max(maxImagePixels, width * height);
      }
    }
  }

  return { maxImagePixels, imageCount };
}

/** True when the document carries a scanned or photographed page. */
export function looksScanned(survey: ImageSurvey): boolean {
  return survey.maxImagePixels >= LARGE_IMAGE_MIN_PIXELS;
}
