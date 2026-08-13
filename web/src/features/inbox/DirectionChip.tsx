import { DIRECTION_LABEL } from '@shared';
import type { DocDirection, DocumentDoc } from '@shared';

/**
 * Income or expense, at a glance.
 *
 * Expense was previously grey — technically "a colour", but it read as *absent*, which
 * is the one thing it must not, since it is the side of the ledger nearly every document
 * lands on.
 *
 * ── Why expense is violet and not red ──
 * Red is the obvious guess: green income, red expense, the way every accounting product
 * draws it. It is wrong here for two reasons. Expense + pending is the single most
 * common pair of values in the table, so a red chip would sit beside a red status field
 * in most rows and the two would blur into one signal. And a CPA's expenses are not bad
 * news — colouring 90% of the page red says something about the documents that isn't
 * true, and drains the red that marks a genuine failure.
 *
 * Violet is outside the status vocabulary entirely (green / amber / red) and outside the
 * brand accent, so it can never be mistaken for either. It carries no innate meaning —
 * but it does not have to: the chip has the Hebrew word inside it. Colour here is a
 * scanning aid, not the only signal.
 *
 * Amber stays reserved for "a human should look at this", which is why `unknown` wears
 * it — the same amber as the Unassigned queue, because it is the same kind of row.
 */

export const DIRECTION_TONE: Record<DocDirection, string> = {
  income: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  expense: 'bg-violet-50 text-violet-800 ring-violet-200',
  neither: 'bg-ink-50 text-ink-500 ring-ink-200',
  unknown: 'bg-amber-50 text-amber-900 ring-amber-300',
};

/** The solid form, for a chosen button rather than a read-only chip. */
export const DIRECTION_SOLID: Record<DocDirection, string> = {
  income: 'bg-emerald-600 text-white',
  expense: 'bg-violet-600 text-white',
  neither: 'bg-ink-500 text-white',
  unknown: 'bg-amber-500 text-white',
};

export default function DirectionChip({ doc }: { doc: Pick<DocumentDoc, 'classification'> }) {
  const c = doc.classification;

  // Absent, not unknown: this document predates classification or has not been read yet.
  // Saying "—" is honest; showing "לא ידוע" would claim we looked.
  if (!c) return <span className="text-xs text-ink-300">—</span>;

  return (
    <span
      dir="rtl"
      title={c.reason}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium
                  ring-1 ${DIRECTION_TONE[c.direction]}`}
    >
      {DIRECTION_LABEL[c.direction]}
      {c.source === 'manual' && <span className="text-[10px] opacity-60">ידני</span>}
    </span>
  );
}
