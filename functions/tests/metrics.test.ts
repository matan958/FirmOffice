import { describe, expect, it } from 'vitest';
import { computeChange, contribution, hasWork } from '../src/metrics/deltas.js';
import type { DocumentDoc } from '../../shared/src/index.js';

/**
 * Counter drift is invisible — a badge reading 7 instead of 6 looks entirely plausible
 * and nobody notices until someone counts by hand. So every transition that moves a
 * badge is pinned here, including the ones that must move NOTHING.
 */

function docOf(over: Partial<DocumentDoc> = {}): DocumentDoc {
  return {
    clientId: 'client-a',
    clientMatch: null,
    clientNameCache: 'Acme',
    uploadedByUid: 'user-a',
    channel: 'web',
    source: { userAgent: 'vitest' },
    file: {
      originalName: 'x.pdf',
      storagePath: 'incoming/client-a/d1/x.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      sha256: '',
    },
    thumbnailPath: null,
    duplicateOf: null,
    pipelineStatus: 'uploading',
    workflowStatus: 'pending',
    assignedAccountantUid: null,
    ocr: null,
    extracted: {},
    error: null,
    receivedAt: null as never,
    createdAt: null as never,
    updatedAt: null as never,
    deletedAt: null,
    ...over,
  };
}

describe('contribution', () => {
  it('counts a live document', () => {
    expect(contribution(docOf())).toEqual({
      workflow: 'pending',
      unassigned: false,
      ocrFailed: false,
    });
  });

  it('counts nothing for a soft-deleted document', () => {
    // Otherwise deleting something would leave its badge incremented forever.
    expect(contribution(docOf({ deletedAt: {} as never }))).toEqual({
      workflow: null,
      unassigned: false,
      ocrFailed: false,
    });
  });

  it('treats a null clientId as unassigned', () => {
    expect(contribution(docOf({ clientId: null })).unassigned).toBe(true);
  });
});

describe('computeChange — creation', () => {
  it('increments pending and the channel, and logs ingested', () => {
    const c = computeChange(undefined, docOf());
    expect(c.counts).toEqual({ pending: 1 });
    expect(c.byChannel).toEqual({ web: 1 });
    expect(c.eventType).toBe('ingested');
  });

  it('increments unassigned for a document with no client', () => {
    const c = computeChange(undefined, docOf({ clientId: null }));
    expect(c.counts).toEqual({ pending: 1, unassigned: 1 });
  });
});

describe('computeChange — workflow transitions', () => {
  it('moves the count from pending to in_progress', () => {
    const c = computeChange(docOf(), docOf({ workflowStatus: 'in_progress' }));
    expect(c.counts).toEqual({ pending: -1, in_progress: 1 });
    expect(c.eventType).toBe('status_changed');
    expect([c.from, c.to]).toEqual(['pending', 'in_progress']);
  });

  it('does not touch byChannel on an update', () => {
    // Only creation counts a channel; re-counting on every edit would inflate it.
    const c = computeChange(docOf(), docOf({ workflowStatus: 'processed' }));
    expect(c.byChannel).toEqual({});
  });
});

describe('computeChange — the two axes stay independent', () => {
  it('an OCR failure does NOT move the workflow badges', () => {
    // The whole reason for two status fields: a machine failure must not make a
    // document vanish from the firm's Pending count.
    const c = computeChange(docOf(), docOf({ pipelineStatus: 'ocr_failed' }));
    expect(c.counts).toEqual({ ocr_failed: 1 });
    expect(c.eventType).toBe('ocr_failed');
  });

  it('clears the ocr_failed count when a retry succeeds', () => {
    const c = computeChange(
      docOf({ pipelineStatus: 'ocr_failed' }),
      docOf({ pipelineStatus: 'ocr_done' }),
    );
    expect(c.counts).toEqual({ ocr_failed: -1 });
    expect(c.eventType).toBe('ocr_completed');
  });

  it('records ocr_started without moving any badge', () => {
    const c = computeChange(docOf(), docOf({ pipelineStatus: 'ocr_running' }));
    expect(c.counts).toEqual({});
    expect(c.eventType).toBe('ocr_started');
  });
});

describe('computeChange — assignment and deletion', () => {
  it('decrements unassigned when a document is filed to a client', () => {
    const c = computeChange(docOf({ clientId: null }), docOf({ clientId: 'client-a' }));
    expect(c.counts).toEqual({ unassigned: -1 });
  });

  it('removes every contribution on soft delete', () => {
    const c = computeChange(
      docOf({ clientId: null, pipelineStatus: 'ocr_failed' }),
      docOf({ clientId: null, pipelineStatus: 'ocr_failed', deletedAt: {} as never }),
    );
    expect(c.counts).toEqual({ pending: -1, unassigned: -1, ocr_failed: -1 });
    expect(c.eventType).toBe('deleted');
  });

  it('ignores a hard delete rather than double-decrementing', () => {
    expect(computeChange(docOf(), undefined)).toEqual({
      counts: {},
      byChannel: {},
      eventType: null,
      from: null,
      to: null,
    });
  });
});

describe('computeChange — no-ops', () => {
  it('produces no work for an updatedAt-only touch', () => {
    const c = computeChange(docOf(), docOf());
    expect(hasWork(c)).toBe(false);
  });

  it('produces no counter work for an unrelated field change', () => {
    const c = computeChange(docOf(), docOf({ clientNameCache: 'Acme Ltd' }));
    expect(c.counts).toEqual({});
    expect(hasWork(c)).toBe(false);
  });
});
