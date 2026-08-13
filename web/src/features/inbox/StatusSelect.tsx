import type { WorkflowStatus } from '@shared';

/**
 * The HUMAN state — and the only control in an inbox row that changes anything.
 *
 * Colour is the whole point: an accountant scanning fifty rows should see what is left
 * to do without reading a word. Green is done, amber is in hand, red is untouched.
 *
 * Red on `pending` is a deliberate departure from the palette note in index.css, where
 * red means "this failed". Pending is not a failure — it is every document the moment it
 * arrives, so it is also the most common state on the page. That is exactly why it is
 * the *softest* of the three here: a tinted background, never the hard `text-red-600`
 * the OCR failures use, so a real alarm still outranks a merely full queue.
 *
 * Shared with the viewer rather than duplicated, so the two screens can never drift into
 * disagreeing about what a colour means.
 */

const TONE: Record<WorkflowStatus, string> = {
  pending: 'border-red-300 bg-red-50 text-red-800 focus:border-red-500 focus:ring-red-500/25',
  in_progress:
    'border-amber-300 bg-amber-50 text-amber-900 focus:border-amber-500 focus:ring-amber-500/25',
  processed:
    'border-emerald-300 bg-emerald-50 text-emerald-800 focus:border-emerald-500 focus:ring-emerald-500/25',
};

/** The same three colours as a dot, for places that show counts instead of a control. */
export const STATUS_DOT: Record<WorkflowStatus, string> = {
  pending: 'bg-red-500',
  in_progress: 'bg-amber-500',
  processed: 'bg-emerald-500',
};

export default function StatusSelect({
  value,
  disabled,
  onChange,
}: {
  value: WorkflowStatus;
  disabled?: boolean;
  onChange(next: WorkflowStatus): void;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as WorkflowStatus)}
      aria-label="Workflow status"
      className={`rounded-lg border px-2 py-1 text-xs font-medium outline-none transition-colors
                  focus:ring-2 disabled:opacity-60 ${TONE[value]}`}
    >
      {/* The options are reset to plain black-on-white: the popup inherits the select's
          colours in Chrome, and an amber list on an amber field is unreadable. */}
      <option value="pending" className="bg-white text-ink-900">
        Pending
      </option>
      <option value="in_progress" className="bg-white text-ink-900">
        In progress
      </option>
      <option value="processed" className="bg-white text-ink-900">
        Processed
      </option>
    </select>
  );
}
