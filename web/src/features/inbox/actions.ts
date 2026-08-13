import { arrayUnion, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { COLLECTIONS } from '@shared';
import type { ExtractedFieldSpec } from '@shared';
import type {
  DocDirection,
  GetDocumentUrlRequest,
  GetDocumentUrlResponse,
  LinkIdentifierRequest,
  LinkIdentifierResponse,
  PollGmailResponse,
  ReclassifyClientRequest,
  ReclassifyClientResponse,
  RetryOcrRequest,
  RetryOcrResponse,
  SetClientEmailRequest,
  SetClientEmailResponse,
  WorkflowStatus,
} from '@shared';

export const getDocumentUrlFn = httpsCallable<GetDocumentUrlRequest, GetDocumentUrlResponse>(
  functions,
  'getDocumentUrl',
);

export const retryOcrFn = httpsCallable<RetryOcrRequest, RetryOcrResponse>(functions, 'retryOcr');

/**
 * Moves a document's workflow status.
 *
 * Written directly rather than through a callable, deliberately: the security rules
 * require `statusActorUid` to equal the caller's own uid, so a direct write is already
 * attributable and cannot name someone else. That keeps the UI optimistic and instant
 * — the onSnapshot listener reflects the change before a round-trip completes — while
 * the audit trail still records a real person rather than `system`.
 */
export async function setWorkflowStatus(
  docId: string,
  status: WorkflowStatus,
  actorUid: string,
): Promise<void> {
  await updateDoc(doc(db, COLLECTIONS.documents, docId), {
    workflowStatus: status,
    statusActorUid: actorUid,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Teaches the mapping ladder a sender→client rule, and optionally re-files the
 * documents already waiting from that sender.
 *
 * A callable rather than a direct write, even though the rules would permit one: the
 * identifier key has to be normalized exactly as the resolver normalizes it or the row
 * never matches anything, the public-domain guard has to run, and the backfill needs
 * to scan the queue server-side.
 */
export const linkIdentifierFn = httpsCallable<LinkIdentifierRequest, LinkIdentifierResponse>(
  functions,
  'linkIdentifier',
);

/**
 * Sets the one address a client's mail is recognised by.
 *
 * A callable, because this is three writes that have to agree — the client record, the
 * old mapping row, and the new one — and because the address being claimed may already
 * belong to another client, which must be reported rather than quietly taken.
 */
export const setClientEmailFn = httpsCallable<SetClientEmailRequest, SetClientEmailResponse>(
  functions,
  'setClientEmail',
);

/** Runs the Gmail poller now instead of waiting for the next five-minute tick. */
export const pollGmailNowFn = httpsCallable<void, PollGmailResponse>(functions, 'pollGmailNow');

/**
 * Corrects one extracted field by hand.
 *
 * The key is added to `extraction.correctedFields`, which is what stops a later
 * re-read overwriting it. Without that marker the feature would be actively harmful:
 * an accountant fixes a total, someone hits Retry OCR a week later, and the correction
 * silently reverts to the machine's wrong answer with nothing to show it happened.
 *
 * Written directly rather than through a callable so the edit lands instantly, the
 * same reasoning as workflow status. The rules restrict this to accountants and to
 * these two fields.
 */
export async function correctField(
  docId: string,
  spec: ExtractedFieldSpec,
  input: string,
): Promise<void> {
  const trimmed = input.trim();

  // An emptied field means "not found", not zero and not empty string — the same
  // distinction the extractor is careful about.
  let value: string | number | null = trimmed === '' ? null : trimmed;

  if (spec.kind === 'money' && trimmed !== '') {
    const n = Number(trimmed.replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) throw new Error('Enter a number, for example 248.98');
    value = Math.round(n * 100) / 100;
  }

  if (spec.kind === 'date' && trimmed !== '') {
    // Accept what an Israeli accountant will actually type, store canonical ISO.
    const dmy = trimmed.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
    const iso = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
    if (dmy) {
      value = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
    } else if (!iso) {
      throw new Error('Use dd/mm/yyyy, for example 12/03/2026');
    }
  }

  await updateDoc(doc(db, COLLECTIONS.documents, docId), {
    [`extracted.${spec.key}`]: value,
    'extraction.correctedFields': arrayUnion(spec.key),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Overrides the income/expense direction by hand.
 *
 * `source: 'manual'` is the whole point of the write: every automatic path — extraction,
 * the re-file trigger, the reclassify button — checks it and returns early, so a human
 * decision is never quietly reverted by a later re-read. Exactly the contract
 * `extraction.correctedFields` has for individual fields.
 *
 * `decidedBy` is pinned to the caller's own uid by the security rules, so this doubles
 * as the audit answer to "who decided this was income" — a question that has a real
 * consequence, since the direction is what puts the VAT on one side of the return or
 * the other.
 */
export async function setDirection(
  docId: string,
  direction: DocDirection,
  actorUid: string,
): Promise<void> {
  await updateDoc(doc(db, COLLECTIONS.documents, docId), {
    classification: {
      direction,
      confidence: 1,
      reason: 'נקבע ידנית',
      rule: 'manual',
      source: 'manual',
      decidedBy: actorUid,
      decidedAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  });
}

/**
 * Re-decides income/expense across one client's documents.
 *
 * Costs nothing to run — it re-applies a pure function to fields already stored, with
 * no call to Gemini — which is why it can be a button rather than a scheduled job.
 * Offered after a client's ח.פ. is entered, because that number is what the whole
 * decision compares against and it is usually filled in after the first documents have
 * already been read.
 */
export const reclassifyClientFn = httpsCallable<ReclassifyClientRequest, ReclassifyClientResponse>(
  functions,
  'reclassifyClient',
);

/**
 * Files an unassigned document against a client, or moves it between clients.
 *
 * `clientMatch` is rewritten to record that a human decided this. Leaving the original
 * machine match in place would leave the document claiming it was resolved by, say, a
 * 0.6 domain guess when in fact an accountant overrode exactly that guess — and the
 * "verify?" affordance keyed on low confidence would keep nagging about a decision
 * already made.
 */
export async function assignClient(
  docId: string,
  clientId: string,
  clientName: string,
  actorUid: string,
): Promise<void> {
  await updateDoc(doc(db, COLLECTIONS.documents, docId), {
    clientId,
    clientNameCache: clientName,
    clientMatch: {
      method: 'manual',
      confidence: 1,
      resolvedBy: actorUid,
      resolvedAt: serverTimestamp(),
    },
    updatedAt: serverTimestamp(),
  });
}
