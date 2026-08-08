import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useSession } from '@/features/auth/AuthProvider';
import { COLLECTIONS } from '@shared';
import type { ClientDoc, DocumentDoc } from '@shared';
import { ErrorNote } from '@/features/auth/AuthCard';
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

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">
        {clientName ? `${clientName} — documents` : 'My documents'}
      </h1>
      <p className="mt-1 text-sm text-ink-600">
        Drop invoices, receipts and statements here. PDFs and photos are read
        automatically; spreadsheets are stored as-is.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={[
          'mt-6 cursor-pointer rounded-lg border-2 border-dashed p-10 text-center',
          dragging ? 'border-brand-500 bg-brand-500/5' : 'border-ink-200',
        ].join(' ')}
      >
        <p className="text-sm font-medium">Drop files here, or click to choose</p>
        <p className="mt-1 text-xs text-ink-400">PDF, JPEG, PNG, TIFF, CSV, XLSX · up to 50 MB</p>
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

      {uploads.length > 0 && (
        <ul className="mt-4 space-y-2">
          {uploads.map((u) => (
            <li key={u.id} className="rounded-md border border-ink-200 px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <span className="truncate font-medium">{u.name}</span>
                <span className="shrink-0 text-xs text-ink-400">{formatBytes(u.size)}</span>
              </div>
              {u.state.status === 'uploading' && (
                <div className="mt-2 h-1 w-full overflow-hidden rounded bg-ink-100">
                  <div
                    className="h-full bg-brand-500 transition-[width]"
                    style={{ width: `${Math.round(u.state.progress * 100)}%` }}
                  />
                </div>
              )}
              {u.state.status === 'done' && (
                <p className="mt-1 text-xs text-emerald-600">Uploaded — processing.</p>
              )}
              {u.state.status === 'error' && (
                <p className="mt-1 text-xs text-red-600">{u.state.message}</p>
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

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-ink-600">
        Submitted
      </h2>
      <ul className="mt-3 divide-y divide-ink-200 rounded-lg border border-ink-200">
        {rows === null && <li className="px-4 py-6 text-sm text-ink-400">Loading…</li>}
        {rows?.length === 0 && (
          <li className="px-4 py-6 text-sm text-ink-400">Nothing submitted yet.</li>
        )}
        {rows?.map((d) => (
          <li key={d.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
            <span className="truncate text-sm font-medium">{d.file.originalName}</span>
            <PipelineChip status={d.pipelineStatus} />
          </li>
        ))}
      </ul>
    </main>
  );
}

/**
 * The MACHINE status, shown small. The client's own workflow status is deliberately
 * not surfaced here — "pending" means something to the firm, not to them.
 */
function PipelineChip({ status }: { status: DocumentDoc['pipelineStatus'] }) {
  const label: Record<DocumentDoc['pipelineStatus'], string> = {
    uploading: 'Uploading',
    received: 'Received',
    ocr_queued: 'Queued',
    ocr_running: 'Reading',
    ocr_done: 'Received',
    ocr_failed: 'Received',
    skipped_ocr: 'Received',
    rejected: 'Could not accept',
  };
  const tone = status === 'rejected' ? 'text-red-600' : 'text-ink-400';
  return <span className={`shrink-0 text-xs ${tone}`}>{label[status]}</span>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
