import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { COLLECTIONS } from '@shared';
import type {
  GetDocumentUrlRequest,
  GetDocumentUrlResponse,
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

/** Files an unassigned document against a client, or moves it between clients. */
export async function assignClient(
  docId: string,
  clientId: string,
  clientName: string,
): Promise<void> {
  await updateDoc(doc(db, COLLECTIONS.documents, docId), {
    clientId,
    clientNameCache: clientName,
    updatedAt: serverTimestamp(),
  });
}
