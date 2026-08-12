import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GmailMessage, GmailPart } from '../src/gmail/parts.js';

/**
 * The poller's run loop.
 *
 * `parts.ts` and `resolveClient.ts` are pure and already well covered. This file exists
 * for the half that is not: the loop that talks to Gmail and Firestore, decides what to
 * fetch, and reports whether the run went well. Every bug this project has shipped to
 * production lived in exactly that kind of code — a boundary, reporting success while
 * doing nothing — and none of them were reachable from a unit test of a pure function.
 *
 * Everything external is mocked, so what is under test is the sequencing and the
 * accounting, which is the part that decides whether a stuck mailbox is visible.
 */

// ── Fakes ────────────────────────────────────────────────────────────────────

const api = {
  getMailbox: vi.fn(async () => 'firm@gmail.com'),
  ensureLabel: vi.fn(async (name: string) => `label-${name}`),
  listMessageIds: vi.fn(async () => ({ ids: [] as string[], hasMore: false })),
  getMessage: vi.fn(async (id: string) => messages[id]!),
  getAttachment: vi.fn(async () => Buffer.from('%PDF-1.4 pretend')),
  addLabel: vi.fn(async () => undefined),
};

vi.mock('../src/gmail/api.js', () => ({
  ...api,
  // The function definitions at the bottom of poll.ts read this at import time.
  GMAIL_SECRETS: [],
  GmailAuthError: class GmailAuthError extends Error {},
}));

const ingest = {
  ingestDocument: vi.fn(async () => ({ status: 'ingested' as const, docId: 'doc-1' })),
  alreadyIngested: vi.fn(async () => false),
};
vi.mock('../src/ingest/ingestDocument.js', () => ingest);

/** Records every write so assertions can read what the dashboard would read. */
const writes: Record<string, Record<string, unknown>> = {};

function fakeDoc(path: string) {
  const ref = {
    path,
    get: async () => ({ exists: false, data: () => undefined, ref }),
    set: async (data: Record<string, unknown>) => {
      writes[path] = { ...(writes[path] ?? {}), ...data };
    },
    update: async (data: Record<string, unknown>) => {
      writes[path] = { ...(writes[path] ?? {}), ...data };
    },
    delete: async () => undefined,
  };
  return ref;
}

vi.mock('../src/lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => fakeDoc(path),
    collection: (name: string) => ({ doc: (id: string) => fakeDoc(`${name}/${id}`) }),
    batch: () => ({ set: () => undefined, create: () => undefined, commit: async () => undefined }),
  }),
  adminApp: () => ({}),
  isEmulated: false,
}));

const { runPoll } = await import('../src/gmail/poll.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

let messages: Record<string, GmailMessage> = {};

function pdfPart(over: Partial<GmailPart> = {}): GmailPart {
  return {
    mimeType: 'application/pdf',
    filename: 'invoice.pdf',
    body: { attachmentId: 'att-1', size: 40_000 },
    ...over,
  };
}

function mail(id: string, over: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: '1754640000000',
    labelIds: [],
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'danny@acme.co.il' },
        { name: 'To', value: 'firm@gmail.com' },
        { name: 'Subject', value: 'חשבונית מרץ' },
      ],
      parts: [pdfPart()],
    },
    ...over,
  };
}

/** Queues the given messages and points the list call at them. */
function inbox(...ms: GmailMessage[]) {
  messages = Object.fromEntries(ms.map((m) => [m.id, m]));
  api.listMessageIds.mockResolvedValue({ ids: ms.map((m) => m.id), hasMore: false });
}

const STATE = 'ingestState/gmail';

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(writes)) delete writes[key];
  api.getMailbox.mockResolvedValue('firm@gmail.com');
  api.ensureLabel.mockImplementation(async (name: string) => `label-${name}`);
  api.getMessage.mockImplementation(async (id: string) => messages[id]!);
  api.getAttachment.mockResolvedValue(Buffer.from('%PDF-1.4 pretend'));
  api.addLabel.mockResolvedValue(undefined);
  ingest.alreadyIngested.mockResolvedValue(false);
  ingest.ingestDocument.mockResolvedValue({ status: 'ingested', docId: 'doc-1' });
  inbox();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('run accounting', () => {
  it('ingests each attachment and labels the message processed', async () => {
    inbox(mail('m1'), mail('m2'));

    const res = await runPoll();

    expect(res.ok).toBe(true);
    expect(res.messagesSeen).toBe(2);
    expect(res.attachmentsIngested).toBe(2);
    expect(res.messagesFailed).toBe(0);
    expect(api.addLabel).toHaveBeenCalledWith('m1', 'label-FirmOffice/Processed');
    expect(api.addLabel).toHaveBeenCalledWith('m2', 'label-FirmOffice/Processed');
  });

  it('publishes the mailbox, without which no drop address can be shown', async () => {
    await runPoll();
    expect(writes[STATE]?.['mailbox']).toBe('firm@gmail.com');
  });

  it('labels an archive for attention rather than marking it processed', async () => {
    inbox(
      mail('m1', {
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'From', value: 'danny@acme.co.il' }],
          parts: [pdfPart({ mimeType: 'application/zip', filename: 'docs.zip' })],
        },
      }),
    );

    await runPoll();

    // Refused, not stored — and left visible in the mailbox instead of evaporating.
    expect(api.addLabel).toHaveBeenCalledWith('m1', 'label-FirmOffice/Attention');
    expect(ingest.ingestDocument).not.toHaveBeenCalled();
  });
});

describe('one bad message does not stall the firm', () => {
  it('keeps processing after a failure and labels the failure for attention', async () => {
    inbox(mail('m1'), mail('m2'), mail('m3'));
    api.getAttachment.mockImplementation(async () => {
      if (api.getAttachment.mock.calls.length === 2) throw new Error('Gmail 500');
      return Buffer.from('%PDF-1.4 pretend');
    });

    const res = await runPoll();

    expect(res.ok).toBe(true);
    expect(res.messagesSeen).toBe(3);
    expect(res.attachmentsIngested).toBe(2);
    expect(res.messagesFailed).toBe(1);
    expect(api.addLabel).toHaveBeenCalledWith('m2', 'label-FirmOffice/Attention');
  });

  it('reports the failure count where the dashboard reads it', async () => {
    inbox(mail('m1'));
    api.getAttachment.mockRejectedValue(new Error('Gmail 500'));

    await runPoll();

    expect(writes[STATE]?.['lastRunFailures']).toBe(1);
    expect(writes[STATE]?.['lastError']).toContain('Gmail 500');
  });
});

describe('the starved queue — a full page that never drains', () => {
  it('records that Gmail had more waiting', async () => {
    messages = { m1: mail('m1') };
    api.listMessageIds.mockResolvedValue({ ids: ['m1'], hasMore: true });

    const res = await runPoll();

    expect(res.hasMore).toBe(true);
    expect(writes[STATE]?.['lastRunHadMore']).toBe(true);
  });

  it('still reports the run as successful, because the run did complete', async () => {
    // The distinction the two extra fields exist for. Moving lastSuccessAt on a
    // message-level failure would make one permanently broken message look identical
    // to a dead poller; leaving only lastSuccessAt makes a starved queue look healthy.
    // Both facts have to be recorded separately.
    messages = { m1: mail('m1') };
    api.listMessageIds.mockResolvedValue({ ids: ['m1'], hasMore: true });
    api.getAttachment.mockRejectedValue(new Error('nope'));

    const res = await runPoll();

    expect(res.ok).toBe(true);
    expect(writes[STATE]?.['lastSuccessAt']).toBeDefined();
    expect(writes[STATE]?.['lastRunFailures']).toBe(1);
    expect(writes[STATE]?.['lastRunHadMore']).toBe(true);
  });
});

describe('work that must not be repeated', () => {
  it('does not re-download an attachment already in the ledger', async () => {
    // The whole point of asking before fetching. A message that cannot be labelled is
    // re-selected on every run for two days; without this its bytes come down from
    // Gmail each time only to be discarded.
    inbox(mail('m1'));
    ingest.alreadyIngested.mockResolvedValue(true);

    const res = await runPoll();

    expect(api.getAttachment).not.toHaveBeenCalled();
    expect(ingest.ingestDocument).not.toHaveBeenCalled();
    expect(res.skippedDuplicates).toBe(1);
  });

  it('skips a message that already carries the processed label', async () => {
    inbox(mail('m1', { labelIds: ['label-FirmOffice/Processed'] }));

    await runPoll();

    expect(ingest.ingestDocument).not.toHaveBeenCalled();
    expect(api.addLabel).not.toHaveBeenCalled();
  });
});

describe('an attachment Gmail returns empty', () => {
  it('is counted and logged, never silently dropped', async () => {
    inbox(mail('m1'));
    api.getAttachment.mockResolvedValue(Buffer.alloc(0));

    const res = await runPoll();

    expect(res.skippedEmpty).toBe(1);
    expect(ingest.ingestDocument).not.toHaveBeenCalled();
    // Still labelled: there is nothing to retry, and leaving it unlabelled would have
    // it re-read on every run for the rest of the window.
    expect(api.addLabel).toHaveBeenCalledWith('m1', 'label-FirmOffice/Processed');
  });
});

describe('a dead refresh token', () => {
  it('fails the whole run and touches no message', async () => {
    // The seven-day Testing-status expiry lands here. It must not look like a quiet
    // mailbox: the run has to be marked failed so the dashboard turns amber.
    inbox(mail('m1'));
    api.getMailbox.mockRejectedValue(new Error('invalid_grant'));

    const res = await runPoll();

    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('invalid_grant');
    expect(api.getMessage).not.toHaveBeenCalled();
    expect(writes[STATE]?.['lastSuccessAt']).toBeUndefined();
    expect(writes[STATE]?.['consecutiveFailures']).toBeDefined();
  });
});
