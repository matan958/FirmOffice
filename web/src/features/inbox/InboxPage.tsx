import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useSession } from '@/features/auth/AuthProvider';
import { ErrorNote } from '@/features/auth/AuthCard';
import { COLLECTIONS } from '@shared';
import type { ClientDoc, Timestampish, WorkflowStatus } from '@shared';
import MetricsBar from './MetricsBar';
import PipelineChip from './PipelineChip';
import { useDocuments, type DocRow } from './useDocuments';
import { setWorkflowStatus } from './actions';

/**
 * The accountant's inbox.
 *
 * Filters live in the URL so a particular view — "Globex, pending" — can be linked,
 * bookmarked, and survives a reload. That matters more than it sounds: an accountant
 * working a queue loses their place on every refresh otherwise.
 */
export default function InboxPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();

  const status = (params.get('status') ?? 'all') as WorkflowStatus | 'all';
  const clientId = params.get('client') ?? 'all';
  const unassignedOnly = params.get('unassigned') === '1';

  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    return onSnapshot(query(collection(db, COLLECTIONS.clients), orderBy('name')), (snap) =>
      setClients(snap.docs.map((d) => ({ id: d.id, name: (d.data() as ClientDoc).name }))),
    );
  }, []);

  const docs = useDocuments({ status, clientId, unassignedOnly });

  const patch = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  return (
    <main className="mx-auto max-w-6xl p-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <label className="flex items-center gap-2 text-sm text-ink-600">
          Client
          <select
            value={unassignedOnly ? '__unassigned' : clientId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__unassigned') patch({ unassigned: '1', client: null });
              else patch({ unassigned: null, client: v === 'all' ? null : v });
            }}
            className="rounded-md border border-ink-200 bg-white px-2 py-1 text-sm"
          >
            <option value="all">All clients</option>
            <option value="__unassigned">Unassigned</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-6">
        <MetricsBar
          active={status}
          onSelect={(s) => patch({ status: s === 'all' ? null : s })}
        />
      </div>

      {docs.status === 'error' && (
        <div className="mt-6">
          <ErrorNote message={docs.message} />
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-200 text-xs uppercase text-ink-600">
            <tr>
              <th className="px-4 py-2 font-medium">Document</th>
              <th className="px-4 py-2 font-medium">Client</th>
              <th className="px-4 py-2 font-medium">Received</th>
              <th className="px-4 py-2 font-medium">Pipeline</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-200">
            {docs.status === 'loading' && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-ink-400">
                  Loading…
                </td>
              </tr>
            )}
            {docs.status === 'ready' && docs.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-ink-400">
                  Nothing here. {status !== 'all' && 'Try a different status.'}
                </td>
              </tr>
            )}
            {docs.status === 'ready' &&
              docs.rows.map((row) => (
                <Row key={row.id} row={row} actorUid={session?.user.uid} />
              ))}
          </tbody>
        </table>
      </div>

      {docs.status === 'ready' && docs.atLimit && (
        <p className="mt-3 text-xs text-ink-400">
          Showing the 50 most recent. Narrow by client or status to see further back.
        </p>
      )}
    </main>
  );
}

function Row({ row, actorUid }: { row: DocRow; actorUid: string | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move(next: WorkflowStatus) {
    if (!actorUid) return;
    setBusy(true);
    setError(null);
    try {
      await setWorkflowStatus(row.id, next, actorUid);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={row.duplicateOf ? 'opacity-60' : undefined}>
      <td className="px-4 py-2">
        <Link
          to={`/inbox/${row.id}`}
          className="font-medium text-brand-600 underline-offset-2 hover:underline"
        >
          {row.file.originalName}
        </Link>
        {row.duplicateOf && (
          <span className="ml-2 text-xs text-ink-400" title={`Same bytes as ${row.duplicateOf}`}>
            duplicate
          </span>
        )}
        {row.ocr?.preview && (
          <div className="mt-0.5 line-clamp-1 max-w-md text-xs text-ink-400">
            {row.ocr.preview.replace(/\s+/g, ' ').slice(0, 120)}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-ink-600">
        {row.clientNameCache ?? <span className="text-amber-700">unassigned</span>}
      </td>
      <td className="px-4 py-2 text-xs text-ink-600">{formatWhen(row.receivedAt)}</td>
      <td className="px-4 py-2">
        <PipelineChip doc={row} />
      </td>
      <td className="px-4 py-2">
        <select
          value={row.workflowStatus}
          disabled={busy || !actorUid}
          onChange={(e) => void move(e.target.value as WorkflowStatus)}
          className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs"
        >
          <option value="pending">Pending</option>
          <option value="in_progress">In progress</option>
          <option value="processed">Processed</option>
        </select>
        {error && <p className="mt-1 max-w-40 text-xs text-red-600">{error}</p>}
      </td>
    </tr>
  );
}

/**
 * Firestore timestamps arrive as null while a serverTimestamp write is still pending
 * locally, so this has to tolerate that rather than throwing mid-render.
 */
function formatWhen(ts: Timestampish | null | undefined): string {
  if (!ts?.toDate) return '—';
  const d = ts.toDate();
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
}
