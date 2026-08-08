import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { COLLECTIONS } from '@shared';
import type {
  GetDocumentUrlRequest,
  GetDocumentUrlResponse,
  LinkIdentifierRequest,
  LinkIdentifierResponse,
  PollGmailResponse,
  RetryOcrRequest,
  RetryOcrResponse,
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

/** Runs the Gmail poller now instead of waiting for the next five-minute tick. */
export const pollGmailNowFn = httpsCallable<void, PollGmailResponse>(functions, 'pollGmailNow');

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
