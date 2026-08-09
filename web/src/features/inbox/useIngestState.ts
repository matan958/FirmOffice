import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { COLLECTIONS } from '@shared';
import type { IngestStateDoc } from '@shared';

/**
 * The Gmail poller's health, live.
 *
 * Worth surfacing in the UI rather than leaving to logs, because of how this fails: a
 * dead refresh token, a revoked grant or a paused scheduler all present as an inbox
 * that simply stops filling up, which is indistinguishable from a quiet week until
 * someone notices a missing document near a filing deadline. `lastSuccessAt` is the
 * one value that separates those two cases.
 */
export function useIngestState(): (IngestStateDoc & { exists: boolean }) | null {
  const [state, setState] = useState<(IngestStateDoc & { exists: boolean }) | null>(null);

  useEffect(() => {
    return onSnapshot(
      doc(db, COLLECTIONS.ingestState, 'gmail'),
      // Null while the document does not exist, which is the state before Gmail has
      // ever been connected. Callers hide their UI entirely rather than showing an
      // amber "never completed a run" warning about a channel nobody has turned on —
      // a permanent false alarm is worse than no indicator, because it teaches people
      // to ignore the one place a real outage would appear.
      (snap) => setState(snap.exists() ? { exists: true, ...(snap.data() as IngestStateDoc) } : null),
      // A client role cannot read this collection; failing quietly is correct.
      () => setState(null),
    );
  }, []);

  return state;
}

/** Minutes since the poller last completed a run, or null if it never has. */
export function minutesSinceSuccess(state: IngestStateDoc | null): number | null {
  const ts = state?.lastSuccessAt;
  if (!ts?.toMillis) return null;
  return Math.floor((Date.now() - ts.toMillis()) / 60_000);
}
