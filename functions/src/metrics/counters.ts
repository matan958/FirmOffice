import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { computeChange, hasWork, metricsPatch } from './deltas.js';
import { reclassifyDocument } from '../classify/reclassify.js';
import { COLLECTIONS, METRICS_DOC_ID, SUBCOLLECTIONS } from '../shared.js';
import type { DocumentDoc } from '../shared.js';

/**
 * Maintains /metrics/global and appends to each document's audit trail.
 *
 * Aggregation queries were rejected for the badges because getCountFromServer() cannot
 * be subscribed to, and the counts must be live. One counter document supports roughly
 * a sustained write per second — orders of magnitude above a CPA firm's volume. If
 * that ever changed, shard it; do not pre-build that.
 *
 * ── Exactly-once, which increments badly need ──
 * Firestore triggers are at-least-once, so a naive increment would double-count on any
 * retry, and that drift is permanent and invisible. The audit entry is written with the
 * trigger's own event ID as its document ID, using create() — which fails if it already
 * exists — in the SAME batch as the increment. A redelivery hits the existing event
 * document, the whole batch aborts, and the counters are untouched. The audit trail
 * doubles as the idempotency ledger, so this costs no extra write.
 *
 * The arithmetic itself lives in deltas.ts and is unit-tested there.
 */
export const onDocumentChanged = onDocumentWritten(
  `${COLLECTIONS.documents}/{docId}`,
  async (event) => {
    const docId = event.params['docId'];
    if (!docId) return;

    const before = event.data?.before.exists
      ? (event.data.before.data() as DocumentDoc)
      : undefined;
    const after = event.data?.after.exists ? (event.data.after.data() as DocumentDoc) : undefined;

    // A document that arrived unassigned was classified against no client at all. The
    // moment an accountant files it, income-vs-expense becomes answerable — so answer
    // it here rather than making them press a button for something already derivable.
    //
    // Guarded on `extraction` so this does not fire on create, when there are no fields
    // to decide from yet; extraction writes its own classification a moment later. The
    // write below only touches `classification`, so the re-fire it causes sees an
    // unchanged clientId and stops. Placed above the hasWork() early return, which is
    // about metrics deltas and would skip a pure re-filing.
    if (after?.clientId && before?.clientId !== after.clientId && after.extraction) {
      await reclassifyDocument(docId).catch((err: unknown) =>
        logger.warn('counters: reclassify failed', { docId, err: String(err) }),
      );
    }

    const change = computeChange(before, after);
    if (!hasWork(change)) return; // e.g. an updatedAt-only touch

    // NESTED maps, never dotted keys. set(..., { merge: true }) treats a key containing
    // a dot as a literal field name — only update() reads it as a path — so dotted keys
    // here would create a field called "counts.pending" and leave counts undefined.
    const patch = metricsPatch(change);
    const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    const toIncrements = (m: Record<string, number>) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, FieldValue.increment(v)]));

    if (patch.counts) payload['counts'] = toIncrements(patch.counts);
    if (patch.byChannel) payload['byChannel'] = toIncrements(patch.byChannel);

    const batch = db().batch();

    batch.create(
      db()
        .collection(COLLECTIONS.documents)
        .doc(docId)
        .collection(SUBCOLLECTIONS.events)
        .doc(event.id),
      {
        type: change.eventType ?? 'status_changed',
        // A human moved the status only if statusActorUid changed with it. The rules
        // pin that field to the writer's own uid, so it cannot name someone else.
        // Machine transitions (ingest, OCR) leave it null and stay attributed to the
        // system, which is honest — no person touched them.
        actor:
          change.eventType === 'status_changed' && after?.statusActorUid
            ? { type: 'user', uid: after.statusActorUid }
            : { type: 'system' },
        from: change.from,
        to: change.to,
        at: FieldValue.serverTimestamp(),
      },
    );

    if (patch.counts || patch.byChannel) {
      batch.set(db().collection(COLLECTIONS.metrics).doc(METRICS_DOC_ID), payload, {
        merge: true,
      });
    }

    try {
      await batch.commit();
    } catch (err: unknown) {
      const code = (err as { code?: number | string })?.code;
      if (code === 6 || code === 'already-exists') {
        logger.debug('counters: duplicate delivery ignored', { docId, eventId: event.id });
        return;
      }
      throw err;
    }
  },
);
