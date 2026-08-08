import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { bucket, db } from '../lib/firebase.js';
import { requireAccountant } from '../lib/auth.js';
import { COLLECTIONS, SIGNED_URL_TTL_MINUTES, SUBCOLLECTIONS } from '../shared.js';
import type { DocumentDoc, GetDocumentUrlRequest, GetDocumentUrlResponse } from '../shared.js';

/**
 * Mints a short-lived signed URL for a document's bytes, and records who looked.
 *
 * Nobody — not even an accountant — can read the bucket through storage.rules. Preview
 * bytes are only reachable through here, and that is deliberate: for a CPA firm, "who
 * opened which client's document, and when" is a compliance-grade question, and
 * routing every view through one callable makes it answerable for the cost of one
 * extra write. Direct bucket access would silently bypass the trail.
 *
 * Requires the Functions service account to hold roles/iam.serviceAccountTokenCreator
 * ON ITSELF. Without it signing fails with an error that never mentions IAM.
 */
export const getDocumentUrl = onCall<GetDocumentUrlRequest, Promise<GetDocumentUrlResponse>>(
  async (request) => {
    const caller = requireAccountant(request);
    const docId = request.data?.docId;

    if (typeof docId !== 'string' || docId.length === 0) {
      throw new HttpsError('invalid-argument', 'docId is required.');
    }

    const docRef = db().collection(COLLECTIONS.documents).doc(docId);
    const snap = await docRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such document.');

    const document = snap.data() as DocumentDoc;
    const storagePath = document.file?.storagePath;
    if (!storagePath) {
      throw new HttpsError('failed-precondition', 'This document has no stored file.');
    }

    const expiresAt = Date.now() + SIGNED_URL_TTL_MINUTES * 60_000;

    let url: string;
    try {
      [url] = await bucket().file(storagePath).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: expiresAt,
      });
    } catch (err: unknown) {
      // Almost always the missing serviceAccountTokenCreator self-binding. Say so,
      // because the underlying message does not.
      logger.error('signed url failed', { docId, storagePath, err: String(err) });
      throw new HttpsError(
        'internal',
        'Could not sign a preview URL. Check that the Functions service account holds ' +
          'roles/iam.serviceAccountTokenCreator on itself.',
      );
    }

    // Append-only: one entry per view, never updated. The subcollection is unreadable
    // and unwritable from the client, so this cannot be tampered with after the fact.
    await docRef
      .collection(SUBCOLLECTIONS.events)
      .add({
        type: 'viewed',
        actor: { type: 'user', uid: caller.uid },
        at: FieldValue.serverTimestamp(),
      })
      .catch((err: unknown) => {
        // A failed audit write must not deny access — but it must be loud, because a
        // silent gap in a compliance trail is worse than a noisy one.
        logger.error('audit write failed for view', { docId, uid: caller.uid, err: String(err) });
      });

    return {
      url,
      contentType: document.file.contentType,
      expiresAt,
    };
  },
);
