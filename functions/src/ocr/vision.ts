import { ImageAnnotatorClient } from '@google-cloud/vision';
import { logger } from 'firebase-functions';
import { bucket } from '../lib/firebase.js';
import { joinPages, type OcrExtraction, type OcrPage } from './types.js';
import { STORAGE_PREFIX, VISION_SYNC_PAGE_LIMIT } from '../shared.js';

/**
 * Cloud Vision, behind an interface.
 *
 * Vision has no emulator — it is a real, billed, external API. Every other part of the
 * pipeline can be exercised locally, so the engine is an injectable dependency rather
 * than a direct import: the task handler takes an OcrEngine, and tests pass a fake.
 * Without that seam, nothing downstream of OCR could be tested without spending money.
 */

export interface OcrEngine {
  /** Single image. Vision cannot do this for PDFs at all. */
  image(gcsUri: string): Promise<OcrExtraction>;
  /** PDF up to VISION_SYNC_PAGE_LIMIT pages — inline response. */
  pdfSync(gcsUri: string): Promise<OcrExtraction>;
  /** Longer PDF: long-running operation writing JSON to GCS. */
  pdfAsync(gcsUri: string, docId: string): Promise<OcrExtraction>;
}

type VisionPage = {
  confidence?: number | null;
  property?: { detectedLanguages?: Array<{ languageCode?: string | null }> | null } | null;
  width?: number | null;
  height?: number | null;
};

function summarize(pages: VisionPage[]): { confidence: number | null; languages: string[] } {
  const confidences = pages
    .map((p) => p.confidence)
    .filter((c): c is number => typeof c === 'number');

  const languages = new Set<string>();
  for (const p of pages) {
    for (const l of p.property?.detectedLanguages ?? []) {
      if (l.languageCode) languages.add(l.languageCode);
    }
  }

  return {
    confidence: confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null,
    languages: [...languages],
  };
}

let client: ImageAnnotatorClient | undefined;
function vision(): ImageAnnotatorClient {
  // Lazy: merely importing this module must not open a connection, because the
  // Functions loader imports every module when discovering exports.
  if (!client) client = new ImageAnnotatorClient();
  return client;
}

export const visionEngine: OcrEngine = {
  async image(gcsUri) {
    const [result] = await vision().documentTextDetection(gcsUri);
    const annotation = result.fullTextAnnotation;
    const visionPages = (annotation?.pages ?? []) as VisionPage[];
    const { confidence, languages } = summarize(visionPages);

    const pages: OcrPage[] = [
      {
        pageNumber: 1,
        text: annotation?.text ?? '',
        confidence,
        width: visionPages[0]?.width ?? null,
        height: visionPages[0]?.height ?? null,
      },
    ];

    return {
      engine: 'vision-v1',
      method: 'documentTextDetection',
      pages,
      fullText: annotation?.text ?? '',
      avgConfidence: confidence,
      languageCodes: languages,
    };
  },

  async pdfSync(gcsUri) {
    const [result] = await vision().batchAnnotateFiles({
      requests: [
        {
          inputConfig: { gcsSource: { uri: gcsUri }, mimeType: 'application/pdf' },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          // 1..N; Vision refuses more than VISION_SYNC_PAGE_LIMIT synchronously.
          pages: Array.from({ length: VISION_SYNC_PAGE_LIMIT }, (_, i) => i + 1),
        },
      ],
    });

    const responses = result.responses?.[0]?.responses ?? [];
    const pages: OcrPage[] = [];
    const allVisionPages: VisionPage[] = [];

    for (const r of responses) {
      const annotation = r.fullTextAnnotation;
      if (!annotation) continue;
      const vp = (annotation.pages ?? []) as VisionPage[];
      allVisionPages.push(...vp);
      pages.push({
        // context.pageNumber, NOT the array index: Vision may omit blank pages, and
        // index-based numbering would then silently misalign every later page.
        pageNumber: r.context?.pageNumber ?? pages.length + 1,
        text: annotation.text ?? '',
        confidence: vp[0]?.confidence ?? null,
        width: vp[0]?.width ?? null,
        height: vp[0]?.height ?? null,
      });
    }

    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    const { confidence, languages } = summarize(allVisionPages);

    return {
      engine: 'vision-v1',
      method: 'batchAnnotateFiles',
      pages,
      fullText: joinPages(pages),
      avgConfidence: confidence,
      languageCodes: languages,
    };
  },

  async pdfAsync(gcsUri, docId) {
    const outPrefix = `${STORAGE_PREFIX.ocrOutput}/${docId}/`;
    const gcsDestinationUri = `gs://${bucket().name}/${outPrefix}`;

    const [operation] = await vision().asyncBatchAnnotateFiles({
      requests: [
        {
          inputConfig: { gcsSource: { uri: gcsUri }, mimeType: 'application/pdf' },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          outputConfig: { gcsDestination: { uri: gcsDestinationUri }, batchSize: 5 },
        },
      ],
    });

    // A 50-page scan is typically 30–90s. If the task times out anyway, Cloud Tasks
    // retries and the handler's idempotency guard restarts cleanly.
    await operation.promise();

    const [files] = await bucket().getFiles({ prefix: outPrefix });
    const pages: OcrPage[] = [];
    const allVisionPages: VisionPage[] = [];

    for (const file of files) {
      if (!file.name.endsWith('.json')) continue;
      const [contents] = await file.download();
      const parsed = JSON.parse(contents.toString('utf8')) as {
        responses?: Array<{
          context?: { pageNumber?: number };
          fullTextAnnotation?: { text?: string; pages?: VisionPage[] };
        }>;
      };

      for (const r of parsed.responses ?? []) {
        const annotation = r.fullTextAnnotation;
        if (!annotation) continue;
        const vp = annotation.pages ?? [];
        allVisionPages.push(...vp);
        pages.push({
          // Assembling by context.pageNumber rather than by output filename ranges,
          // which are easy to get subtly wrong and produce silently shuffled text.
          pageNumber: r.context?.pageNumber ?? pages.length + 1,
          text: annotation.text ?? '',
          confidence: vp[0]?.confidence ?? null,
          width: vp[0]?.width ?? null,
          height: vp[0]?.height ?? null,
        });
      }
    }

    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    const { confidence, languages } = summarize(allVisionPages);

    logger.info('vision async complete', { docId, pages: pages.length, files: files.length });

    return {
      engine: 'vision-v1',
      method: 'asyncBatchAnnotateFiles',
      pages,
      fullText: joinPages(pages),
      avgConfidence: confidence,
      languageCodes: languages,
    };
  },
};
