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
import type { DocDirection, DocumentDoc, WorkflowStatus } from '@shared';

export type DocRow = DocumentDoc & { id: string };

export interface DocumentFilters {
  status: WorkflowStatus | 'all';
  clientId: string | 'all';
  /** Show only documents with no client — the Unassigned queue. */
  unassignedOnly?: boolean;
  /** Income / expense / neither / unknown. `unknown` is the review queue. */
  direction?: DocDirection | 'all';
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
 * cover: status alone, client alone, direction alone, or any combination of the three.
 * Adding a channel filter on top would need another eight, so it is deliberately left
 * out rather than silently failing at runtime with a missing-index error.
 */
export function useDocuments(filters: DocumentFilters, pageSize = 50): DocumentsState {
  const [state, setState] = useState<DocumentsState>({ status: 'loading' });
  const { status, clientId, unassignedOnly, direction } = filters;

  useEffect(() => {
    const constraints: QueryConstraint[] = [];

    if (unassignedOnly) {
      constraints.push(where('clientId', '==', null));
    } else if (clientId !== 'all') {
      constraints.push(where('clientId', '==', clientId));
    }
    if (status !== 'all') constraints.push(where('workflowStatus', '==', status));

    // Documents predating classification have no `classification` map at all, so they
    // match no direction filter — including 'unknown'. That is the honest behaviour:
    // "never classified" is not the same as "classified and undecidable", and quietly
    // folding the two together would hide a backlog rather than surface it.
    if (direction && direction !== 'all') {
      constraints.push(where('classification.direction', '==', direction));
    }

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
  }, [status, clientId, unassignedOnly, direction, pageSize]);

  return state;
}
