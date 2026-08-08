import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { computeChange, hasWork } from './deltas.js';
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

    const change = computeChange(before, after);
    if (!hasWork(change)) return; // e.g. an updatedAt-only touch

    const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    for (const [field, by] of Object.entries(change.counts)) {
      payload[`counts.${field}`] = FieldValue.increment(by);
    }
    for (const [channel, by] of Object.entries(change.byChannel)) {
      payload[`byChannel.${channel}`] = FieldValue.increment(by);
    }

    const batch = db().batch();

    batch.create(
      db()
        .collection(COLLECTIONS.documents)
        .doc(docId)
        .collection(SUBCOLLECTIONS.events)
        .doc(event.id),
      {
        // TODO(M3): accountant-driven status changes should carry the acting uid. The
        // document does not record who wrote it, so route those through a callable
        // rather than a direct client write — otherwise this stays 'system' and the
        // trail cannot answer "who marked this processed", which is the whole point.
        type: change.eventType ?? 'status_changed',
        actor: { type: 'system' },
        from: change.from,
        to: change.to,
        at: FieldValue.serverTimestamp(),
      },
    );

    if (Object.keys(change.counts).length > 0 || Object.keys(change.byChannel).length > 0) {
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
