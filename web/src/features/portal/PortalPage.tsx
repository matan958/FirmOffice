import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useSession } from '@/features/auth/AuthProvider';
import { COLLECTIONS } from '@shared';
import type { ClientDoc, DocumentDoc, Timestampish } from '@shared';
import { ErrorNote, Spinner } from '@/features/auth/AuthCard';
import { rejectReason, uploadFile, type UploadItem } from './upload';

type Row = DocumentDoc & { id: string };

/**
 * Client Portal — drag & drop upload plus the client's own document history.
 *
 * The in-flight list is deliberately separate from the Firestore list. A document's
 * `receivedAt` is a serverTimestamp, which is null in the local cache until the server
 * acknowledges the write, so an ordered query cannot show it instantly. Showing upload
 * progress from local state means the client sees feedback on the first byte rather
 * than after the round-trip.
 *
 * Everything the client is shown is phrased from their side of the relationship. They
 * do not need to know a document is `ocr_queued`; they need to know it arrived. The
 * one exception is a rejection, which is theirs to act on.
 */
export default function PortalPage() {
  const session = useSession();
  const [clientName, setClientName] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const clientId = session?.clientId ?? null;

  useEffect(() => {
    if (!clientId) return;
    return onSnapshot(
      doc(db, COLLECTIONS.clients, clientId),
      (snap) => setClientName(snap.exists() ? (snap.data() as ClientDoc).name : null),
      () => setClientName(null),
    );
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;
    const q = query(
      collection(db, COLLECTIONS.documents),
      where('clientId', '==', clientId),
      orderBy('receivedAt', 'desc'),
      limit(50),
    );
    return onSnapshot(
      q,
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentDoc) }))),
      (err) => setError(err.message),
    );
  }, [clientId]);

  const start = useCallback(
    async (files: File[]) => {
      if (!clientId || !session) return;

      for (const file of files) {
        const id = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
        const reason = rejectReason(file);

        if (reason) {
          setUploads((u) => [
            { id, name: file.name, size: file.size, state: { status: 'error', message: reason } },
            ...u,
          ]);
          continue;
        }

        setUploads((u) => [
          { id, name: file.name, size: file.size, state: { status: 'uploading', progress: 0 } },
          ...u,
        ]);

        const patch = (state: UploadItem['state']) =>
          setUploads((u) => u.map((it) => (it.id === id ? { ...it, state } : it)));

        try {
          await uploadFile(
            file,
            { clientId, clientName, uid: session.user.uid },
            (p) => patch({ status: 'uploading', progress: p }),
          );
          patch({ status: 'done' });
        } catch (err: unknown) {
          patch({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    [clientId, clientName, session],
  );

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    void start(Array.from(e.dataTransfer.files));
  }

  const inFlight = uploads.some((u) => u.state.status === 'uploading');

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {clientName ? clientName : 'My documents'}
        </h1>
        <p className="mt-1.5 text-sm text-ink-600">
          Send invoices, receipts and statements to your accountant. Everything you
          upload here is read automatically and appears in their queue.
        </p>
      </header>

      {/* ── dropzone ── */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Add documents"
        className={[
          'mt-7 cursor-pointer rounded-xl border-2 border-dashed px-6 py-12 text-center',
          'transition-colors',
          dragging
            ? 'border-brand-500 bg-brand-50'
            : 'border-ink-300 bg-white hover:border-brand-400 hover:bg-brand-50/40',
        ].join(' ')}
      >
        <span
          className={[
            'mx-auto grid size-12 place-items-center rounded-full transition-colors',
            dragging ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-600',
          ].join(' ')}
          aria-hidden
        >
          <svg
            width={22}
            height={22}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 15.5V4m0 0L8 8m4-4 4 4" />
            <path d="M3.5 15v3.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V15" />
          </svg>
        </span>

        <p className="mt-4 text-sm font-medium">
          {dragging ? 'Release to upload' : 'Drop files here, or click to choose'}
        </p>
        <p className="mt-1 text-xs text-ink-400">
          PDF, photos (JPEG, PNG, HEIC), scans, spreadsheets · up to 50 MB each
        </p>

        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void start(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      <p className="mt-3 text-center text-xs text-ink-400">
        A photo of a paper receipt is fine — it will be read automatically.
      </p>

      {/* ── in-flight ── */}
      {uploads.length > 0 && (
        <ul className="mt-6 space-y-2">
          {uploads.map((u) => (
            <li key={u.id} className="card px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0 truncate text-sm font-medium">{u.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-ink-400">
                  {u.state.status === 'uploading'
                    ? `${Math.round(u.state.progress * 100)}%`
                    : formatBytes(u.size)}
                </span>
              </div>

              {u.state.status === 'uploading' && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-[width] duration-200"
                    style={{ width: `${Math.max(2, Math.round(u.state.progress * 100))}%` }}
                  />
                </div>
              )}
              {u.state.status === 'done' && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-700">
                  <CheckIcon /> Sent to your accountant
                </p>
              )}
              {u.state.status === 'error' && (
                <p className="mt-1.5 text-xs text-red-600">{u.state.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-6">
          <ErrorNote message={error} />
        </div>
      )}

      {/* ── history ── */}
      <div className="mt-10 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">Sent</h2>
        {inFlight && (
          <span className="flex items-center gap-1.5 text-xs text-ink-400">
            <Spinner /> uploading
          </span>
        )}
      </div>

      <ul className="card mt-3 divide-y divide-ink-200">
        {rows === null && (
          <li className="flex items-center gap-2 px-4 py-6 text-sm text-ink-400">
            <Spinner /> Loading…
          </li>
        )}
        {rows?.length === 0 && (
          <li className="px-4 py-10 text-center">
            <p className="text-sm text-ink-600">Nothing sent yet.</p>
            <p className="mt-1 text-xs text-ink-400">
              Your uploads will be listed here with their status.
            </p>
          </li>
        )}
        {rows?.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{d.file.originalName}</span>
              <span className="block text-xs text-ink-400">
                {formatWhen(d.receivedAt)} · {formatBytes(d.file.sizeBytes)}
              </span>
            </span>
            <ClientStatus doc={d} />
          </li>
        ))}
      </ul>
    </main>
  );
}

/**
 * Status in the CLIENT's terms.
 *
 * The machine pipeline is collapsed to three outcomes that mean something to the
 * person who sent the file: it is on its way, it arrived, or it could not be accepted
 * and they need to do something. A client seeing "OCR failed" would reasonably
 * conclude their document was lost — it was not; it is in the accountant's queue and
 * simply has no searchable text yet.
 */
function ClientStatus({ doc }: { doc: DocumentDoc }) {
  if (doc.pipelineStatus === 'rejected') {
    return (
      <span
        className="shrink-0 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
        title={doc.error?.message ?? undefined}
      >
        Could not accept
      </span>
    );
  }

  if (doc.pipelineStatus === 'uploading') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-xs text-ink-600">
        <Spinner /> Sending
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
      <CheckIcon /> Received
    </span>
  );
}

function CheckIcon() {
  return (
    <svg
      className="size-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Null while a serverTimestamp write is still pending locally — must not throw. */
function formatWhen(ts: Timestampish | null | undefined): string {
  if (!ts?.toDate) return 'just now';
  return ts.toDate().toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
