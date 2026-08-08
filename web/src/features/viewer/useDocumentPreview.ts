import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocumentUrlFn } from '@/features/inbox/actions';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string; contentType: string; expiresAt: number }
  | { status: 'error'; message: string };

/**
 * Fetches a short-lived signed URL for a document's bytes.
 *
 * The URL expires after 15 minutes, and an accountant can easily leave a document open
 * longer than that — so this re-fetches shortly BEFORE expiry rather than waiting for a
 * request to fail. Without that, a viewer left open over lunch would silently show a
 * broken page and look like the document had vanished.
 *
 * Every call writes a `viewed` audit entry server-side, which is intended: a refresh is
 * genuine continued access, and a trail that under-reports is worse than one that
 * repeats.
 */
export function useDocumentPreview(docId: string | undefined): PreviewState & {
  reload(): void;
} {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    if (!docId) return;
    setState({ status: 'loading' });
    try {
      const res = await getDocumentUrlFn({ docId });
      setState({ status: 'ready', ...res.data });
    } catch (err: unknown) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [docId]);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    // Refresh a minute before the URL dies, with a floor so clock skew cannot schedule
    // this in the past and spin.
    const delay = Math.max(15_000, state.expiresAt - Date.now() - 60_000);
    timer.current = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer.current);
  }, [state, load]);

  return { ...state, reload: () => void load() };
}
