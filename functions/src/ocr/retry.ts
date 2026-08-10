import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { requireAccountant } from '../lib/auth.js';
import { enqueueOcr } from './enqueue.js';
import { classify } from '../ingest/classify.js';
import { COLLECTIONS } from '../shared.js';
import type { DocumentDoc, RetryOcrRequest, RetryOcrResponse } from '../shared.js';

/**
 * Re-runs OCR for a document.
 *
 * Essential ops kit, not a nice-to-have: OCR fails for reasons that are transient
 * (quota, a bad minute at Vision) or fixed by a later deploy, and without this the only
 * remedy is asking the client to upload the file again — which looks to them like the
 * firm lost it.
 *
 * Deliberately permissive about WHICH states may retry. A document stuck in
 * `ocr_queued` because an enqueue silently went nowhere is exactly the case that needs
 * rescuing, and it is indistinguishable from a slow one without a human deciding.
 */
export const retryOcr = onCall<RetryOcrRequest, Promise<RetryOcrResponse>>(async (request) => {
  const caller = requireAccountant(request);
  const docId = request.data?.docId;

  if (typeof docId !== 'string' || docId.length === 0) {
    throw new HttpsError('invalid-argument', 'docId is required.');
  }

  const docRef = db().collection(COLLECTIONS.documents).doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such document.');

  const document = snap.data() as DocumentDoc;

  if (document.pipelineStatus === 'rejected') {
    // Rejected means the bytes themselves were unusable and were moved to quarantine —
    // there is nothing at the original path left to read.
    return { docId, requeued: false, reason: 'This document was rejected at ingest.' };
  }

  if (classify(document.file.contentType) !== 'ocr') {
    return {
      docId,
      requeued: false,
      reason: `${document.file.contentType} cannot be read by OCR; it is stored as-is.`,
    };
  }

  // Clear the previous failure before re-queuing, so a stale error is not left sitting
  // on a document that is now running again. The status has to move BEFORE the
  // enqueue, because the task handler's idempotency guard reads it — a task that ran
  // first would see `ocr_done` and skip.
  await docRef.update({
    pipelineStatus: 'ocr_queued',
    error: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    await enqueueOcr(docId);
  } catch (err: unknown) {
    // Put the document back where it was and record why. Without this, a failed
    // enqueue leaves it sitting in `ocr_queued` for ever — visibly "Queued", with no
    // error on it, and no worker that will ever pick it up. That is exactly what
    // happened when this function's enqueue was broken: the callable returned
    // INTERNAL to the browser and the document silently became unrecoverable through
    // the UI, because the next retry would do the same thing again.
    logger.error('retryOcr: enqueue failed', { docId, err: String(err) });
    await docRef
      .update({
        pipelineStatus: document.pipelineStatus,
        error: {
          code: 'INTERNAL',
          message: `Could not queue OCR: ${String(err)}`,
          stage: 'ocr',
          attempts: (document.error?.attempts ?? 0) + 1,
          lastAttemptAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);

    throw new HttpsError('internal', 'Could not queue this document for OCR. Try again.');
  }

  logger.info('retryOcr', { actor: caller.uid, docId, previous: document.pipelineStatus });

  return { docId, requeued: true };
});
