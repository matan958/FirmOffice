import type { DocEventType, DocumentDoc } from '../shared.js';

/**
 * Pure counter/audit arithmetic, free of firebase imports so it unit-tests directly.
 *
 * Counter drift is invisible: a badge that reads 7 instead of 6 looks entirely
 * plausible and nobody notices until someone counts by hand. That makes this the piece
 * most worth testing exhaustively and least worth trusting to inspection.
 */

export interface Contribution {
  workflow: DocumentDoc['workflowStatus'] | null;
  unassigned: boolean;
  ocrFailed: boolean;
}

/** What a document contributes to the badges. A soft-deleted one contributes nothing. */
export function contribution(d: DocumentDoc | undefined): Contribution {
  if (!d || d.deletedAt) return { workflow: null, unassigned: false, ocrFailed: false };
  return {
    workflow: d.workflowStatus,
    unassigned: d.clientId === null,
    ocrFailed: d.pipelineStatus === 'ocr_failed',
  };
}

export interface Change {
  /** Field name under `counts.` → signed delta. Only non-zero entries appear. */
  counts: Record<string, number>;
  /** Channel name → delta. Only populated on create. */
  byChannel: Record<string, number>;
  eventType: DocEventType | null;
  from: string | null;
  to: string | null;
}

function bump(counts: Record<string, number>, field: string, by: number): void {
  if (by !== 0) counts[field] = (counts[field] ?? 0) + by;
}

/** Diffs two document states into the counter deltas and the audit entry they imply. */
export function computeChange(
  before: DocumentDoc | undefined,
  after: DocumentDoc | undefined,
): Change {
  const empty: Change = { counts: {}, byChannel: {}, eventType: null, from: null, to: null };
  // A hard delete leaves nothing to audit against. Soft delete is the supported path
  // and arrives as an update with deletedAt set.
  if (!after) return empty;

  const was = contribution(before);
  const is = contribution(after);
  const counts: Record<string, number> = {};

  if (was.workflow !== is.workflow) {
    if (was.workflow) bump(counts, was.workflow, -1);
    if (is.workflow) bump(counts, is.workflow, 1);
  }
  bump(counts, 'unassigned', (is.unassigned ? 1 : 0) - (was.unassigned ? 1 : 0));
  bump(counts, 'ocr_failed', (is.ocrFailed ? 1 : 0) - (was.ocrFailed ? 1 : 0));

  const byChannel: Record<string, number> = {};
  if (!before) byChannel[after.channel] = 1;

  let eventType: DocEventType | null = null;
  let from: string | null = null;
  let to: string | null = null;

  if (!before) {
    eventType = 'ingested';
  } else if (before.deletedAt === null && after.deletedAt !== null) {
    eventType = 'deleted';
  } else if (before.workflowStatus !== after.workflowStatus) {
    eventType = 'status_changed';
    from = before.workflowStatus;
    to = after.workflowStatus;
  } else if (before.pipelineStatus !== after.pipelineStatus) {
    if (after.pipelineStatus === 'ocr_failed') eventType = 'ocr_failed';
    else if (after.pipelineStatus === 'ocr_done') eventType = 'ocr_completed';
    else if (after.pipelineStatus === 'ocr_running') eventType = 'ocr_started';
    from = before.pipelineStatus;
    to = after.pipelineStatus;
  }

  return { counts, byChannel, eventType, from, to };
}

export function hasWork(change: Change): boolean {
  return (
    change.eventType !== null ||
    Object.keys(change.counts).length > 0 ||
    Object.keys(change.byChannel).length > 0
  );
}
