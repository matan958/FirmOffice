import type { DocumentDoc, PipelineStatus } from '@shared';

/**
 * The MACHINE state, shown small and never mixed with the workflow badges.
 *
 * This separation is the point of having two status fields: a document whose OCR failed
 * still sits in Pending for the firm, and the failure shows here as an operational
 * detail rather than removing it from anyone's queue.
 */

const LABEL: Record<PipelineStatus, string> = {
  uploading: 'Uploading',
  received: 'Received',
  ocr_queued: 'Queued',
  ocr_running: 'Reading…',
  ocr_done: 'Read',
  ocr_failed: 'OCR failed',
  skipped_ocr: 'Not readable',
  rejected: 'Rejected',
};

const TONE: Record<PipelineStatus, string> = {
  uploading: 'text-ink-400',
  received: 'text-ink-400',
  ocr_queued: 'text-ink-400',
  ocr_running: 'text-brand-600',
  ocr_done: 'text-emerald-600',
  ocr_failed: 'text-red-600',
  skipped_ocr: 'text-ink-400',
  rejected: 'text-red-600',
};

export default function PipelineChip({ doc }: { doc: DocumentDoc }) {
  const status = doc.pipelineStatus;
  const stale = status === 'ocr_queued' || status === 'ocr_running';

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${TONE[status]}`}>
      {stale && (
        <span
          aria-hidden
          className="inline-block size-1.5 animate-pulse rounded-full bg-current"
        />
      )}
      {LABEL[status]}
      {status === 'ocr_done' && doc.ocr?.lowConfidence && (
        <span className="text-amber-600" title="Average OCR confidence was low">
          · low confidence
        </span>
      )}
      {status === 'ocr_done' && doc.ocr?.pageCount === 0 && (
        <span className="text-amber-600">· no text found</span>
      )}
    </span>
  );
}
