import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { db } from '../lib/firebase.js';
import { requireAccountant } from '../lib/auth.js';
import { reclassifyDocument } from '../classify/reclassify.js';
import { COLLECTIONS, RECLASSIFY_SCAN_LIMIT } from '../shared.js';
import type { ReclassifyClientRequest, ReclassifyClientResponse } from '../shared.js';

/**
 * Re-decides income vs expense across one client's documents.
 *
 * This exists because of the order things happen in real life. The ladder compares the
 * ח.פ. on a document against the ח.פ. on the client record, and the client record is
 * routinely completed AFTER their first documents have already been read — so without
 * this, entering a ח.פ. would fix classification for future documents only, and every
 * document already in the system would sit at "unknown" for ever.
 *
 * It is free to run: no Vision, no Gemini, no file downloads. It re-reads fields that
 * are already stored and re-applies a pure function to them. That is the dividend from
 * deciding direction in code rather than asking the model, and it is the reason this
 * can be offered as a button instead of a budgeted batch job.
 *
 * A button, deliberately, and not an onWrite trigger on /clients: a single edit fanning
 * out into hundreds of document writes should be something a person chose to do and can
 * see the result of.
 */
export const reclassifyClient = onCall<ReclassifyClientRequest, Promise<ReclassifyClientResponse>>(
  async (request) => {
    const caller = requireAccountant(request);
    const clientId = request.data?.clientId;

    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new HttpsError('invalid-argument', 'clientId is required.');
    }

    const clientSnap = await db().collection(COLLECTIONS.clients).doc(clientId).get();
    if (!clientSnap.exists) throw new HttpsError('not-found', 'No such client.');

    // Bounded, like linkIdentifier's backfill. An unbounded scan on a busy client would
    // run past the callable timeout and report nothing at all, which is a worse outcome
    // than doing part of the work and saying so — hence `truncated` in the response.
    const docs = await db()
      .collection(COLLECTIONS.documents)
      .where('clientId', '==', clientId)
      .orderBy('receivedAt', 'desc')
      .limit(RECLASSIFY_SCAN_LIMIT)
      .get();

    let changed = 0;
    let skippedManual = 0;

    for (const snap of docs.docs) {
      const outcome = await reclassifyDocument(snap.id).catch((err: unknown) => {
        logger.warn('reclassifyClient: one document failed', { docId: snap.id, err: String(err) });
        return 'skipped' as const;
      });
      if (outcome === 'changed') changed++;
      if (outcome === 'manual') skippedManual++;
    }

    logger.info('reclassifyClient', {
      actor: caller.uid,
      clientId,
      scanned: docs.size,
      changed,
      skippedManual,
    });

    return {
      clientId,
      scanned: docs.size,
      changed,
      skippedManual,
      truncated: docs.size === RECLASSIFY_SCAN_LIMIT,
    };
  },
);
