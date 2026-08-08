import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { bucket, db } from '../lib/firebase.js';
import { tokenize, wasTruncated } from './tokenize.js';
import type { OcrExtraction } from './types.js';
import {
  COLLECTIONS,
  LOW_CONFIDENCE_THRESHOLD,
  OCR_INLINE_TEXT_LIMIT_BYTES,
  OCR_PREVIEW_CHARS,
  STORAGE_PREFIX,
  SUBCOLLECTIONS,
} from '../shared.js';
import type { OcrResult, PipelineStatus } from '../shared.js';

/**
 * Persists an extraction: the OCR summary, the per-page text, and the search tokens.
 *
 * The 1 MiB problem lives here. A Firestore document is capped at 1 MiB and the write
 * simply FAILS past it — a dense 50-page scan's text can exceed that on its own. So
 * text over OCR_INLINE_TEXT_LIMIT_BYTES is spilled to Storage and the field left null.
 * `preview` is always populated inline, so list views and snippets never need a
 * Storage round-trip to show something.
 *
 * Pages are written to a subcollection for the same reason, and because the M3 split
 * viewer syncs its text panel to the visible PDF page.
 */

export interface WriteOptions {
  docId: string;
  extraction: OcrExtraction;
  startedAt: number;
  /** Overrides the derived status — used for store-only files that skipped OCR. */
  pipelineStatus?: PipelineStatus;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export async function writeOcrResult({
  docId,
  extraction,
  startedAt,
  pipelineStatus = 'ocr_done',
}: WriteOptions): Promise<void> {
  const { fullText, pages } = extraction;

  // Spill oversized text rather than losing the write. Retaining full text is also
  // what keeps the search decision reversible — a future move to a real search engine
  // is a backfill over this, not a re-OCR.
  let inlineText: string | null = fullText;
  let textStoragePath: string | null = null;

  if (byteLength(fullText) >= OCR_INLINE_TEXT_LIMIT_BYTES) {
    textStoragePath = `${STORAGE_PREFIX.ocrText}/${docId}/fulltext.txt`;
    await bucket()
      .file(textStoragePath)
      .save(fullText, {
        contentType: 'text/plain; charset=utf-8',
        metadata: { contentDisposition: 'attachment' },
      });
    inlineText = null;
    logger.info('ocr text spilled to storage', {
      docId,
      bytes: byteLength(fullText),
      textStoragePath,
    });
  }

  const tokens = tokenize(fullText);

  const ocr: Omit<OcrResult, 'completedAt'> & { completedAt: FirebaseFirestore.FieldValue } = {
    engine: extraction.engine,
    method: extraction.method,
    fullText: inlineText,
    textStoragePath,
    preview: fullText.slice(0, OCR_PREVIEW_CHARS),
    pageCount: pages.length,
    avgConfidence: extraction.avgConfidence,
    lowConfidence:
      extraction.avgConfidence !== null && extraction.avgConfidence < LOW_CONFIDENCE_THRESHOLD,
    languageCodes: extraction.languageCodes,
    completedAt: FieldValue.serverTimestamp(),
    durationMs: Date.now() - startedAt,
    tokensTruncated: wasTruncated(tokens),
  };

  const docRef = db().collection(COLLECTIONS.documents).doc(docId);

  // Pages FIRST, in chunks, then the document update.
  //
  // A Firestore batch holds at most 500 writes, and Vision accepts PDFs up to 2000
  // pages, so a single batch would fail outright on a large scan. Chunking loses
  // atomicity, hence the ordering: pages land before the document claims ocr_done, so
  // the invariant "ocr_done implies the pages exist" survives a crash mid-write. The
  // reverse order would leave a document advertising text that is not there.
  const PAGE_CHUNK = 450;
  for (let i = 0; i < pages.length; i += PAGE_CHUNK) {
    const batch = db().batch();
    for (const page of pages.slice(i, i + PAGE_CHUNK)) {
      batch.set(
        // Page number as the document ID keeps re-runs idempotent — a retry overwrites
        // page 3 rather than appending a second copy of it.
        docRef.collection(SUBCOLLECTIONS.pages).doc(String(page.pageNumber)),
        page,
      );
    }
    await batch.commit();
  }

  await docRef.update({
    ocr,
    searchTokens: tokens,
    pipelineStatus,
    'file.pageCount': pages.length,
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('ocr written', {
    docId,
    method: extraction.method,
    pages: pages.length,
    chars: fullText.length,
    tokens: tokens.length,
    truncated: ocr.tokensTruncated,
    spilled: textStoragePath !== null,
  });
}
