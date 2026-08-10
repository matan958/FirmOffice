import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { db } from '../lib/firebase.js';
import { decideDirection } from './direction.js';
import { COLLECTIONS } from '../shared.js';
import type { Classification, ClientDoc, DocumentDoc, ExtractedFields } from '../shared.js';

/**
 * Applies the direction ladder to stored data.
 *
 * The valuable property here is that this costs NOTHING to run. It reads the fields
 * that are already on the document and the ח.פ. that is already on the client, and
 * decides between them — no Vision, no Gemini, no bytes downloaded. That is the whole
 * dividend from deciding direction in code instead of asking the model, and it is what
 * makes it reasonable to re-decide a client's entire back catalogue the moment somebody
 * finally types their ח.פ. into the system.
 */

/** serverTimestamp() is a sentinel, not a Timestamp, until it lands. */
export type ClassificationWrite = Omit<Classification, 'decidedAt'> & {
  decidedAt: FirebaseFirestore.FieldValue;
};

export type ReclassifyOutcome = 'changed' | 'unchanged' | 'manual' | 'skipped';

/**
 * Decides the direction for one document's fields against its client.
 *
 * Returns null when there is no client to decide against — an unassigned document is
 * genuinely unclassifiable, and writing `unknown` onto it would be indistinguishable
 * from having tried and failed. It gets classified the moment an accountant files it.
 */
export async function buildClassification(
  clientId: string | null,
  fields: ExtractedFields,
): Promise<ClassificationWrite | null> {
  if (!clientId) return null;

  const snap = await db().collection(COLLECTIONS.clients).doc(clientId).get();
  if (!snap.exists) return null;
  const client = snap.data() as ClientDoc;

  const decided = decideDirection({
    clientTaxId: client.taxId ?? null,
    clientName: client.name ?? null,
    clientLegalName: client.legalName ?? null,
    fields,
  });

  return {
    ...decided,
    source: 'auto',
    decidedBy: null,
    decidedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Re-decides one stored document and writes the result if it moved.
 *
 * Two things it will not do. It never touches a classification a human set by hand —
 * the same contract `extraction.correctedFields` has, and for the same reason: a system
 * that quietly reverts an accountant's correction is worse than one that never offered
 * to classify at all. And it does not write when the answer is unchanged, which keeps
 * the onDocumentWritten trigger from re-firing itself.
 */
export async function reclassifyDocument(docId: string): Promise<ReclassifyOutcome> {
  const docRef = db().collection(COLLECTIONS.documents).doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) return 'skipped';

  const doc = snap.data() as DocumentDoc;
  if (doc.classification?.source === 'manual') return 'manual';

  const next = await buildClassification(doc.clientId, doc.extracted ?? {});
  if (!next) return 'skipped';

  const current = doc.classification;
  if (current && current.direction === next.direction && current.rule === next.rule) {
    return 'unchanged';
  }

  await docRef.update({
    classification: next,
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('reclassified', {
    docId,
    from: current?.direction ?? null,
    to: next.direction,
    rule: next.rule,
  });
  return 'changed';
}
