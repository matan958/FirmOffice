import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore';
import { Document as PdfDocument, Page as PdfPage } from 'react-pdf';
import '@/features/viewer/pdfWorker';
import { db } from '@/lib/firebase';
import { useSession } from '@/features/auth/AuthProvider';
import { ErrorNote, Spinner } from '@/features/auth/AuthCard';
import { COLLECTIONS, SUBCOLLECTIONS } from '@shared';
import type { ClientDoc, DocumentDoc, PageDoc } from '@shared';
import PipelineChip from '@/features/inbox/PipelineChip';
import SourceChip from '@/features/inbox/SourceChip';
import StatusSelect from '@/features/inbox/StatusSelect';
import AssignDialog from '@/features/inbox/AssignDialog';
import { assignClient, retryOcrFn, setWorkflowStatus } from '@/features/inbox/actions';
import { useDocumentPreview } from './useDocumentPreview';
import ExtractedPanel from './ExtractedPanel';

type Doc = DocumentDoc & { id: string };

/**
 * Split viewer: the original on the left, what the machine read on the right.
 *
 * The panels are deliberately side by side rather than tabbed. The job here is
 * checking OCR against the original — spotting that a total was misread, or that a
 * scan is too faint — and that comparison is impossible if you can only see one at a
 * time.
 *
 * The text panel follows the visible PDF page, which is why OCR writes a `pages`
 * subcollection instead of one blob. It also sidesteps the oversized-text problem:
 * documents above 200 KB spill their full text to Storage, which the browser cannot
 * read, but per-page text always lives in Firestore.
 */
export default function DocumentViewerPage() {
  const { docId } = useParams<{ docId: string }>();
  const session = useSession();

  const [document, setDocument] = useState<Doc | null | 'missing'>(null);
  const [pages, setPages] = useState<PageDoc[]>([]);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);

  const preview = useDocumentPreview(docId);

  // The PDF is rendered to a fixed pixel width, so it has to follow the pane rather
  // than a constant — at a constant 720px it either overflows a laptop's half-width
  // pane or wastes half a large monitor.
  const paneRef = useRef<HTMLElement>(null);
  const [paneWidth, setPaneWidth] = useState(720);

  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPaneWidth(Math.max(280, entry.contentRect.width - 32));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!docId) return;
    return onSnapshot(doc(db, COLLECTIONS.documents, docId), (snap) =>
      setDocument(snap.exists() ? ({ id: snap.id, ...(snap.data() as DocumentDoc) }) : 'missing'),
    );
  }, [docId]);

  useEffect(() => {
    if (!docId) return;
    return onSnapshot(
      query(
        collection(db, COLLECTIONS.documents, docId, SUBCOLLECTIONS.pages),
        orderBy('pageNumber'),
      ),
      (snap) => setPages(snap.docs.map((d) => d.data() as PageDoc)),
      () => setPages([]),
    );
  }, [docId]);

  useEffect(() => {
    return onSnapshot(query(collection(db, COLLECTIONS.clients), orderBy('name')), (snap) =>
      setClients(snap.docs.map((d) => ({ id: d.id, name: (d.data() as ClientDoc).name }))),
    );
  }, []);

  const isPdf =
    document !== null &&
    document !== 'missing' &&
    document.file.contentType === 'application/pdf';

  const pageText = useMemo(() => {
    const hit = pages.find((p) => p.pageNumber === pageNumber);
    if (hit) return hit.text;
    // Single-page images have no pages subcollection entry until OCR completes.
    if (pages.length === 0 && document !== null && document !== 'missing') {
      return document.ocr?.fullText ?? document.ocr?.preview ?? '';
    }
    return '';
  }, [pages, pageNumber, document]);

  if (document === 'missing') {
    return (
      <main className="mx-auto max-w-2xl p-10">
        <h1 className="text-xl font-semibold">Document not found</h1>
        <p className="mt-1 text-sm text-ink-600">
          It may have been removed, or the link may be wrong.
        </p>
        <Link to="/inbox" className="mt-5 inline-block text-sm text-brand-700 underline">
          ← Back to inbox
        </Link>
      </main>
    );
  }

  if (document === null) {
    return (
      <main className="flex items-center gap-2 p-10 text-sm text-ink-500">
        <Spinner /> Loading…
      </main>
    );
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const control =
    'rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs outline-none ' +
    'transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 disabled:opacity-50';

  return (
    <main className="flex h-dvh flex-col">
      {/* ── header ── */}
      <header className="shrink-0 border-b border-ink-200 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            to="/inbox"
            className="shrink-0 rounded-lg px-1.5 py-1 text-sm text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900"
          >
            ← Inbox
          </Link>

          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold" title={document.file.originalName}>
              {document.file.originalName}
            </h1>
            <div className="mt-0.5 flex items-center gap-2">
              <PipelineChip doc={document} />
              <SourceChip doc={document} />
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {document.clientId === null && session ? (
              // Unassigned documents go through the dialog rather than a select, so
              // filing one can also teach the mapping ladder. Reassigning an already
              // filed document is a correction, not a new rule, so it stays a select.
              <button
                onClick={() => setFiling(true)}
                className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs
                           font-medium text-amber-900 transition-colors hover:bg-amber-100"
              >
                File…
              </button>
            ) : (
              <select
                value={document.clientId ?? ''}
                disabled={busy || !session}
                onChange={(e) => {
                  const id = e.target.value;
                  const name = clients.find((c) => c.id === id)?.name ?? '';
                  if (id) void run(() => assignClient(document.id, id, name, session!.user.uid));
                }}
                className={control}
                aria-label="Client"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}

            <StatusSelect
              value={document.workflowStatus}
              disabled={busy || !session}
              onChange={(next) =>
                void run(() => setWorkflowStatus(document.id, next, session!.user.uid))
              }
            />

            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const res = await retryOcrFn({ docId: document.id });
                  setNotice(res.data.requeued ? 'OCR re-queued.' : (res.data.reason ?? ''));
                })
              }
              className={`${control} hover:border-ink-300`}
            >
              Retry OCR
            </button>
          </div>
        </div>

        {document.error && (
          <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            <strong>{document.error.code}</strong> · {document.error.message} (attempt{' '}
            {document.error.attempts})
          </p>
        )}
        {notice && (
          <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            {notice}
          </p>
        )}
        {actionError && (
          <div className="mt-2">
            <ErrorNote message={actionError} />
          </div>
        )}
        {filing && session && (
          <AssignDialog
            doc={document}
            clients={clients}
            actorUid={session.user.uid}
            onClose={() => setFiling(false)}
          />
        )}
      </header>

      {/* ── split panes ── */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section ref={paneRef} className="min-h-0 flex-1 overflow-auto bg-ink-200/60 p-4">
          {preview.status === 'loading' && (
            <p className="flex items-center gap-2 text-sm text-ink-500">
              <Spinner /> Loading preview…
            </p>
          )}
          {preview.status === 'error' && <ErrorNote message={preview.message} />}

          {preview.status === 'ready' && isPdf && (
            <div className="flex flex-col items-center gap-3">
              <div className="overflow-hidden rounded-lg shadow-raised">
                <PdfDocument
                  file={preview.url}
                  onLoadSuccess={({ numPages: n }) => setNumPages(n)}
                  onLoadError={(e) => setActionError(`Could not render PDF: ${e.message}`)}
                  loading={
                    <p className="flex items-center gap-2 p-8 text-sm text-ink-500">
                      <Spinner /> Rendering…
                    </p>
                  }
                >
                  <PdfPage
                    pageNumber={pageNumber}
                    width={Math.min(paneWidth, 900)}
                    // The OCR text lives in its own panel, so pdf.js's own text and
                    // annotation layers add weight and stylesheet coupling for nothing.
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                  />
                </PdfDocument>
              </div>

              {numPages > 1 && (
                <div className="sticky bottom-0 flex items-center gap-3 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-sm shadow-raised">
                  <button
                    onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                    disabled={pageNumber <= 1}
                    className="rounded-full px-2 py-0.5 transition-colors hover:bg-ink-100 disabled:opacity-35"
                  >
                    ‹
                  </button>
                  <span className="tabular-nums text-ink-600">
                    Page {pageNumber} of {numPages}
                  </span>
                  <button
                    onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
                    disabled={pageNumber >= numPages}
                    className="rounded-full px-2 py-0.5 transition-colors hover:bg-ink-100 disabled:opacity-35"
                  >
                    ›
                  </button>
                </div>
              )}
            </div>
          )}

          {preview.status === 'ready' &&
            !isPdf &&
            (document.file.contentType.startsWith('image/') ? (
              <img
                src={preview.url}
                alt={document.file.originalName}
                className="mx-auto max-w-full rounded-lg shadow-raised"
              />
            ) : (
              <div className="card mx-auto max-w-md p-6 text-center">
                <p className="text-sm text-ink-600">
                  {document.file.contentType} cannot be previewed in the browser.
                </p>
                <a
                  href={preview.url}
                  className="mt-3 inline-block text-sm text-brand-700 underline"
                >
                  Download the original
                </a>
              </div>
            ))}
        </section>

        <section className="flex min-h-0 flex-1 flex-col overflow-auto border-t border-ink-200 bg-white lg:border-l lg:border-t-0">
          {/* Fields first, then the raw text underneath. The fields are what gets
              posted to the books; the text is what you check them against. */}
          <div className="border-b border-ink-200">
            <h2 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Fields
            </h2>
            <ExtractedPanel doc={document} actorUid={session?.user.uid} />
          </div>

          <div className="flex items-baseline justify-between gap-2 border-b border-ink-200 bg-white px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Extracted text{numPages > 1 && ` · page ${pageNumber}`}
            </h2>
            {document.ocr && (
              <span className="text-xs text-ink-400">
                {document.ocr.method} · {document.ocr.pageCount}{' '}
                {document.ocr.pageCount === 1 ? 'page' : 'pages'}
                {document.ocr.avgConfidence !== null &&
                  ` · ${Math.round(document.ocr.avgConfidence * 100)}%`}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 p-4">
            {!document.ocr && (
              <p className="text-sm text-ink-400">
                {document.pipelineStatus === 'skipped_ocr'
                  ? 'This file type is stored as-is and is not read automatically.'
                  : 'No text yet — the document has not finished processing.'}
              </p>
            )}

            {document.ocr && pageText.trim().length === 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                No text detected on this page. If the original is a scan, it may be
                blank, too faint, or upside down.
              </p>
            )}

            {pageText.trim().length > 0 && (
              <pre className="whitespace-pre-wrap wrap-break-word font-mono text-xs leading-relaxed text-ink-800">
                {pageText}
              </pre>
            )}

            {document.ocr?.textStoragePath && (
              <p className="mt-4 border-t border-ink-200 pt-3 text-xs text-ink-400">
                Full text exceeded the inline limit and is stored separately; the panel
                shows it a page at a time.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
