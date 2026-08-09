import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { COLLECTIONS, METRICS_DOC_ID } from '@shared';
import type { MetricsDoc, WorkflowStatus } from '@shared';

/**
 * Live status badges, driven by ONE onSnapshot on /metrics/global.
 *
 * Counting with an aggregation query was rejected because getCountFromServer() cannot
 * be subscribed to, and these must move the instant an accountant changes a status —
 * including in someone else's browser.
 *
 * Only workflowStatus is counted here. A document whose OCR failed still appears under
 * Pending, because a machine failure must never make it invisible to the firm; the
 * OCR-failed count sits apart as an operational signal, not a workflow state.
 */

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  processed: 'Processed',
};

export interface MetricsBarProps {
  active: WorkflowStatus | 'all';
  onSelect(next: WorkflowStatus | 'all'): void;
  /** Jumps to the Unassigned queue. The count is useless if reaching it is a hunt. */
  onShowUnassigned(): void;
}

export default function MetricsBar({ active, onSelect, onShowUnassigned }: MetricsBarProps) {
  const [metrics, setMetrics] = useState<MetricsDoc | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    return onSnapshot(
      doc(db, COLLECTIONS.metrics, METRICS_DOC_ID),
      (snap) => {
        setMissing(!snap.exists());
        if (snap.exists()) setMetrics(snap.data() as MetricsDoc);
      },
      () => setMissing(true),
    );
  }, []);

  const counts = metrics?.counts;
  const total = counts ? counts.pending + counts.in_progress + counts.processed : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge label="All" count={total} selected={active === 'all'} onClick={() => onSelect('all')} />
      {(Object.keys(STATUS_LABEL) as WorkflowStatus[]).map((s) => (
        <Badge
          key={s}
          label={STATUS_LABEL[s]}
          count={counts?.[s]}
          selected={active === s}
          onClick={() => onSelect(s)}
        />
      ))}

      <div className="ml-auto flex items-center gap-2 text-xs">
        {counts && counts.unassigned > 0 && (
          <button
            onClick={onShowUnassigned}
            className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 font-medium
                       text-amber-900 transition-colors hover:bg-amber-100"
          >
            {counts.unassigned} unassigned
          </button>
        )}
        {counts && counts.ocr_failed > 0 && (
          <span
            className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 font-medium text-red-800"
            title="Documents whose text could not be read. They are still in the queue — open one and use Retry OCR."
          >
            {counts.ocr_failed} unreadable
          </span>
        )}
        {missing && (
          // The document is created by the counter trigger on first write. Saying so
          // beats showing zeros that look like "no documents".
          <span className="text-ink-400">counters not initialised yet</span>
        )}
      </div>
    </div>
  );
}

function Badge({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number | undefined;
  selected: boolean;
  onClick(): void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={[
        'rounded-lg border px-3 py-1.5 text-sm transition-colors',
        selected
          ? 'border-brand-600 bg-brand-600 text-white shadow-card'
          : 'border-ink-200 bg-white text-ink-600 shadow-card hover:border-ink-300 hover:text-ink-900',
      ].join(' ')}
    >
      {label}
      <span
        className={[
          'ml-2 tabular-nums',
          selected ? 'opacity-85' : 'text-ink-400',
        ].join(' ')}
      >
        {count ?? '·'}
      </span>
    </button>
  );
}
