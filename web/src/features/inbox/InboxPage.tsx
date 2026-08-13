import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useSession } from '@/features/auth/AuthProvider';
import { ErrorNote, Spinner } from '@/features/auth/AuthCard';
import { COLLECTIONS, DIRECTION_LABEL } from '@shared';
import type { ClientDoc, DocDirection, Timestampish, WorkflowStatus } from '@shared';
import MetricsBar from './MetricsBar';
import MailStatus from './MailStatus';
import PipelineChip from './PipelineChip';
import SourceChip from './SourceChip';
import DirectionChip from './DirectionChip';
import StatusSelect from './StatusSelect';
import AssignDialog from './AssignDialog';
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
  const direction = (params.get('direction') ?? 'all') as DocDirection | 'all';

  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    return onSnapshot(query(collection(db, COLLECTIONS.clients), orderBy('name')), (snap) =>
      setClients(snap.docs.map((d) => ({ id: d.id, name: (d.data() as ClientDoc).name }))),
    );
  }, []);

  const docs = useDocuments({ status, clientId, unassignedOnly, direction });

  const patch = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-sm text-ink-600">
            Everything clients have sent, newest first.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-ink-600">
          הכנסה / הוצאה
          <select
            value={direction}
            onChange={(e) => patch({ direction: e.target.value === 'all' ? null : e.target.value })}
            className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm shadow-card
                       outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25"
          >
            <option value="all">הכל</option>
            <option value="income">{DIRECTION_LABEL.income}</option>
            <option value="expense">{DIRECTION_LABEL.expense}</option>
            <option value="neither">{DIRECTION_LABEL.neither}</option>
            {/* The review queue: the ladder ran and could not decide. */}
            <option value="unknown">{DIRECTION_LABEL.unknown} — צריך בדיקה</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-ink-600">
          Client
          <select
            value={unassignedOnly ? '__unassigned' : clientId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__unassigned') patch({ unassigned: '1', client: null });
              else patch({ unassigned: null, client: v === 'all' ? null : v });
            }}
            className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm shadow-card
                       outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25"
          >
            <option value="all">All clients</option>
            <option value="__unassigned">Unassigned only</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        </div>
      </div>

      <div className="mt-6">
        <MetricsBar
          active={status}
          onSelect={(s) => patch({ status: s === 'all' ? null : s })}
          onShowUnassigned={() => patch({ unassigned: '1', client: null })}
        />
      </div>

      {/* Hidden entirely until Gmail is connected — see useIngestState. */}
      <div className="mt-4 empty:mt-0">
        {/* The manual trigger is admin-only server-side, so only offer it to admins —
            an accountant clicking it would get a bare permission-denied. */}
        <MailStatus canPoll={session?.role === 'admin'} />
      </div>

      {docs.status === 'error' && (
        <div className="mt-6">
          <ErrorNote message={docs.message} />
        </div>
      )}

      <div className="card mt-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Document</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">הכנסה / הוצאה</th>
                <th className="px-4 py-2.5 font-medium">Source</th>
                <th className="px-4 py-2.5 font-medium">Received</th>
                <th className="px-4 py-2.5 font-medium">Pipeline</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200">
              {docs.status === 'loading' && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-ink-400">
                    <span className="inline-flex items-center gap-2">
                      <Spinner /> Loading…
                    </span>
                  </td>
                </tr>
              )}
              {docs.status === 'ready' && docs.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <p className="text-sm text-ink-600">Nothing here.</p>
                    <p className="mt-1 text-xs text-ink-400">
                      {status !== 'all' || clientId !== 'all' || unassignedOnly
                        ? 'Try widening the filters above.'
                        : 'Documents appear the moment a client uploads one.'}
                    </p>
                  </td>
                </tr>
              )}
              {docs.status === 'ready' &&
                docs.rows.map((row) => (
                  <Row key={row.id} row={row} actorUid={session?.user.uid} clients={clients} />
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {docs.status === 'ready' && docs.atLimit && (
        <p className="mt-3 text-xs text-ink-400">
          Showing the 50 most recent. Narrow by client or status to see further back.
        </p>
      )}
    </main>
  );
}

function Row({
  row,
  actorUid,
  clients,
}: {
  row: DocRow;
  actorUid: string | undefined;
  clients: { id: string; name: string }[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);

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
    <tr className={`row-hover ${row.duplicateOf ? 'opacity-55' : ''}`}>
      <td className="max-w-sm px-4 py-3">
        <Link
          to={`/inbox/${row.id}`}
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          {row.file.originalName}
        </Link>
        {row.duplicateOf && (
          <span
            className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500"
            title={`Identical bytes to document ${row.duplicateOf}`}
          >
            duplicate
          </span>
        )}
        {row.ocr?.preview && (
          <div className="mt-0.5 truncate text-xs text-ink-400">
            {row.ocr.preview.replace(/\s+/g, ' ').slice(0, 120)}
          </div>
        )}
      </td>

      <td className="px-4 py-3 text-ink-600">
        {row.clientNameCache ?? (
          // The queue is only worth having if clearing it is one click from the list.
          // Making an accountant open each document first is what turns Unassigned
          // into a backlog nobody touches.
          <button
            onClick={() => setFiling(true)}
            disabled={!actorUid}
            className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium
                       text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-40"
          >
            File…
          </button>
        )}
        {filing && actorUid && (
          <AssignDialog
            doc={row}
            clients={clients}
            actorUid={actorUid}
            onClose={() => setFiling(false)}
          />
        )}
      </td>

      <td className="px-4 py-3">
        <DirectionChip doc={row} />
      </td>

      <td className="px-4 py-3">
        <SourceChip doc={row} />
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-xs text-ink-500">
        {formatWhen(row.receivedAt)}
      </td>
      <td className="px-4 py-3">
        <PipelineChip doc={row} />
      </td>
      <td className="px-4 py-3">
        <StatusSelect
          value={row.workflowStatus}
          disabled={busy || !actorUid}
          onChange={(next) => void move(next)}
        />
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
