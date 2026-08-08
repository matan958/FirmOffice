import { useEffect, useState } from 'react';
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { COLLECTIONS } from '@shared';
import type { DocumentDoc, WorkflowStatus } from '@shared';

export type DocRow = DocumentDoc & { id: string };

export interface DocumentFilters {
  status: WorkflowStatus | 'all';
  clientId: string | 'all';
  /** Show only documents with no client — the Unassigned queue. */
  unassignedOnly?: boolean;
}

export type DocumentsState =
  | { status: 'loading' }
  | { status: 'ready'; rows: DocRow[]; atLimit: boolean }
  | { status: 'error'; message: string };

/**
 * Live document list.
 *
 * Sorted by receivedAt — when the CLIENT sent it — not createdAt. After an ingestion
 * outage recovers those diverge sharply, and ordering by our own ingest time would
 * scatter a morning's post through yesterday's list.
 *
 * The filter combinations here are exactly the ones the deployed composite indexes
 * cover: status alone, client alone, or both. Adding a channel filter would need three
 * further index combinations, so it is deliberately left out rather than silently
 * failing at runtime with a missing-index error.
 */
export function useDocuments(filters: DocumentFilters, pageSize = 50): DocumentsState {
  const [state, setState] = useState<DocumentsState>({ status: 'loading' });
  const { status, clientId, unassignedOnly } = filters;

  useEffect(() => {
    const constraints: QueryConstraint[] = [];

    if (unassignedOnly) {
      constraints.push(where('clientId', '==', null));
    } else if (clientId !== 'all') {
      constraints.push(where('clientId', '==', clientId));
    }
    if (status !== 'all') constraints.push(where('workflowStatus', '==', status));

    constraints.push(orderBy('receivedAt', 'desc'), limit(pageSize));

    return onSnapshot(
      query(collection(db, COLLECTIONS.documents), ...constraints),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentDoc) }));
        setState({ status: 'ready', rows, atLimit: rows.length === pageSize });
      },
      (err) => {
        // A missing composite index surfaces here, and the message contains a console
        // link to create it — worth passing through verbatim rather than flattening.
        setState({ status: 'error', message: err.message });
      },
    );
  }, [status, clientId, unassignedOnly, pageSize]);

  return state;
}
