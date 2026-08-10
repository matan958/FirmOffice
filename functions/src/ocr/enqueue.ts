import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions';
import { adminApp, isEmulated } from '../lib/firebase.js';
import { runOcr } from './task.js';
import { FUNCTIONS_REGION } from '../shared.js';
import type { OcrTaskPayload } from './task.js';

/**
 * Fully-qualified queue name. The bare form `taskQueue('ocrTask')` resolves against
 * the DEFAULT region, us-central1 — not the region the function was deployed to. The
 * enqueue then succeeds against a queue nobody is listening to, logs "ocr enqueued",
 * and the document sits in ocr_queued forever with no error anywhere. Including the
 * location is what makes it reach the deployed handler.
 */
const OCR_QUEUE = `locations/${FUNCTIONS_REGION}/functions/ocrTask`;

/**
 * Hands a document to the OCR queue.
 *
 * Under the emulator the task queue is not always wired up, and a failure to enqueue
 * would silently strand every upload in `ocr_queued` with no clue why. Local runs
 * therefore fall through to invoking the handler directly — same code path, no queue.
 * That is a development affordance only; in the cloud it always goes through Tasks,
 * because the backoff and concurrency caps are the entire point.
 */
export async function enqueueOcr(docId: string): Promise<void> {
  if (isEmulated) {
    logger.debug('ocr: running inline (emulator)', { docId });
    // Deliberately not awaited into the trigger's critical path failing — an OCR
    // problem must not make the ingest look broken.
    await runOcr(docId).catch((err: unknown) => {
      logger.warn('inline ocr failed', { docId, err: String(err) });
    });
    return;
  }

  const payload: OcrTaskPayload = { docId };

  // The app is passed EXPLICITLY. The bare `getFunctions()` resolves the global
  // default app, and in the deployed callable runtime that threw "The default Firebase
  // app does not exist" — while the identical call from the Storage trigger, in the
  // same codebase and the same process model, succeeded. Retry OCR was therefore
  // broken from the day it shipped: it moved the document to `ocr_queued`, failed to
  // enqueue, and returned INTERNAL, leaving the document permanently queued.
  await getFunctions(adminApp()).taskQueue<OcrTaskPayload>(OCR_QUEUE).enqueue(payload);
  logger.info('ocr enqueued', { docId, queue: OCR_QUEUE });
}
