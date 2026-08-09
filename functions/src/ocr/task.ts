import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { bucket, db } from '../lib/firebase.js';
import { extractPdfTextLayer } from './pdfText.js';
import { visionEngine, type OcrEngine } from './vision.js';
import { writeOcrResult } from './writeResult.js';
import type { OcrExtraction } from './types.js';
import {
  COLLECTIONS,
  MAX_IMAGE_BYTES,
  VISION_MAX_PAGES,
  VISION_SYNC_PAGE_LIMIT,
} from '../shared.js';
import type { DocumentDoc, ErrorCode } from '../shared.js';

/**
 * OCR runner, dispatched from a Cloud Task rather than called inline.
 *
 * A client dropping 40 files fires 40 storage triggers at once. Calling Vision from
 * inside those would mean 40 concurrent requests, no backoff, and a transient 429
 * retrying the WHOLE trigger — including the hashing and duplicate check. Cloud Tasks
 * gives concurrency caps, exponential backoff, and a clean idempotency boundary for
 * about forty lines. That is the difference between a demo and something that runs
 * unattended.
 */

export interface OcrTaskPayload {
  docId: string;
}

/** Exported for tests, which pass a fake engine — Vision has no emulator. */
export async function runOcr(
  docId: string,
  engine: OcrEngine = visionEngine,
): Promise<'done' | 'skipped' | 'failed'> {
  const startedAt = Date.now();
  const docRef = db().collection(COLLECTIONS.documents).doc(docId);
  const snap = await docRef.get();

  if (!snap.exists) {
    logger.warn('ocr: no such document', { docId });
    return 'skipped';
  }

  const doc = snap.data() as DocumentDoc;

  // Idempotency. Cloud Tasks is at-least-once, and a retry after a successful write
  // must not re-run Vision — that is real money, not just wasted time.
  if (doc.pipelineStatus === 'ocr_done' || doc.pipelineStatus === 'skipped_ocr') {
    logger.debug('ocr: already complete', { docId, status: doc.pipelineStatus });
    return 'skipped';
  }

  const fail = async (code: ErrorCode, message: string, attempts: number) => {
    await docRef.update({
      pipelineStatus: 'ocr_failed',
      error: {
        code,
        message,
        stage: 'ocr',
        attempts,
        lastAttemptAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
  };

  await docRef.update({
    pipelineStatus: 'ocr_running',
    updatedAt: FieldValue.serverTimestamp(),
  });

  const { storagePath, contentType, sizeBytes } = doc.file;
  const gcsUri = `gs://${bucket().name}/${storagePath}`;
  const attempts = (doc.error?.attempts ?? 0) + 1;

  try {
    let extraction: OcrExtraction;

    if (contentType === 'application/pdf') {
      const [bytes] = await bucket().file(storagePath).download();
      const probe = await extractPdfTextLayer(bytes).catch((err: unknown) => {
        // Discriminate rather than blame encryption for everything. Labelling every
        // failure PDF_ENCRYPTED once meant a plain type error reached the user as
        // "this PDF is password-protected" — a diagnosis that sends them looking for a
        // password that does not exist.
        const name = (err as { name?: string })?.name;
        const message = String((err as Error)?.message ?? err);
        const encrypted = name === 'PasswordException' || /password/i.test(message);
        throw Object.assign(new Error(message), {
          ocrCode: (encrypted ? 'PDF_ENCRYPTED' : 'FILE_CORRUPT') satisfies ErrorCode,
        });
      });

      if (probe.pageCount > VISION_MAX_PAGES) {
        await fail(
          'PDF_TOO_MANY_PAGES',
          `${probe.pageCount} pages exceeds Vision's ${VISION_MAX_PAGES}-page limit.`,
          attempts,
        );
        return 'failed';
      }

      if (probe.extraction) {
        // Digital-native PDF: the text was already there. No Vision call, no charge.
        extraction = probe.extraction;
      } else if (probe.pageCount <= VISION_SYNC_PAGE_LIMIT) {
        extraction = await engine.pdfSync(gcsUri, probe.pageCount);
      } else {
        extraction = await engine.pdfAsync(gcsUri, docId);
      }
    } else {
      if (sizeBytes > MAX_IMAGE_BYTES) {
        await fail(
          'FILE_TOO_LARGE',
          `Image is ${sizeBytes} bytes; Vision's limit is ${MAX_IMAGE_BYTES}.`,
          attempts,
        );
        return 'failed';
      }
      extraction = await engine.image(gcsUri);
    }

    // Zero text is NOT a failure — a blank or unreadable scan is a real document with
    // no words in it. Marking it failed would hide it behind an error badge and invite
    // pointless retries of something that will never produce text.
    await writeOcrResult({ docId, extraction, startedAt });
    return 'done';
  } catch (err: unknown) {
    const code = ((err as { ocrCode?: ErrorCode }).ocrCode ?? 'VISION_ERROR') as ErrorCode;
    logger.error('ocr failed', { docId, code, err: String(err), attempts });
    await fail(code, String(err), attempts);
    // Rethrow so Cloud Tasks retries with backoff. The status above is the current
    // best knowledge; a later attempt overwrites it.
    throw err;
  }
}

export const ocrTask = onTaskDispatched<OcrTaskPayload>(
  {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 10 },
    // Caps concurrent Vision calls so a 200-file bulk upload cannot drain the quota —
    // or the budget — in seconds.
    rateLimits: { maxConcurrentDispatches: 6 },
    memory: '1GiB',
    timeoutSeconds: 540,
  },
  async (req) => {
    const docId = req.data?.docId;
    if (!docId) {
      logger.error('ocr task with no docId');
      return;
    }
    await runOcr(docId);
  },
);
