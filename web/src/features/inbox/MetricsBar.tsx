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
}

export default function MetricsBar({ active, onSelect }: MetricsBarProps) {
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

      <div className="ml-auto flex items-center gap-3 text-xs text-ink-600">
        {counts && counts.unassigned > 0 && (
          <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-900">
            {counts.unassigned} unassigned
          </span>
        )}
        {counts && counts.ocr_failed > 0 && (
          <span className="rounded-md bg-red-50 px-2 py-1 text-red-900">
            {counts.ocr_failed} OCR failed
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
        'rounded-md border px-3 py-1.5 text-sm transition-colors',
        selected
          ? 'border-brand-600 bg-brand-600 text-white'
          : 'border-ink-200 text-ink-600 hover:bg-ink-100',
      ].join(' ')}
    >
      {label}
      <span className={selected ? 'ml-2 opacity-90' : 'ml-2 text-ink-400'}>
        {count ?? '·'}
      </span>
    </button>
  );
}
