import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

/**
 * Firestore security rules tests.
 *
 * These run against the Firestore emulator — start it first:
 *   npm run rules:test        (from the repo root; wraps `firebase emulators:exec`)
 *
 * The rules are the security boundary of the whole system, so this suite is written
 * in M0 rather than bolted on later. M1 extends it as auth lands.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(resolve(HERE, '../../firestore.rules'), 'utf8');

const CLIENT_A = 'client-acme';
const CLIENT_B = 'client-globex';

let testEnv: RulesTestEnvironment;

/** Authenticated context carrying the custom claims the rules actually read. */
function asClient(uid: string, clientId: string) {
  return testEnv.authenticatedContext(uid, { role: 'client', clientId }).firestore();
}
function asAccountant(uid = 'acct-1') {
  return testEnv.authenticatedContext(uid, { role: 'accountant' }).firestore();
}
function asAnon() {
  return testEnv.unauthenticatedContext().firestore();
}

/** Minimal document shaped the way the Client Portal will write it. */
function webUploadPayload(clientId: string, uid: string, overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    clientNameCache: null,
    channel: 'web',
    source: { userAgent: 'vitest' },
    file: {
      originalName: 'invoice.pdf',
      storagePath: `incoming/${clientId}/doc1/invoice.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'deadbeef',
    },
    pipelineStatus: 'uploading',
    workflowStatus: 'pending',
    uploadedByUid: uid,
    receivedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    // `demo-` prefixed IDs are recognised by the emulator suite as offline-only,
    // so these tests can never accidentally touch a real project.
    projectId: 'demo-firmoffice',
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed with rules bypassed — this is fixture setup, not behaviour under test.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'documents/doc-a'), {
      ...webUploadPayload(CLIENT_A, 'user-a'),
      pipelineStatus: 'ocr_done',
      ocr: { fullText: 'ACME INVOICE 2026-001', preview: 'ACME INVOICE', pageCount: 1 },
    });
    await setDoc(doc(db, 'documents/doc-b'), {
      ...webUploadPayload(CLIENT_B, 'user-b'),
      pipelineStatus: 'ocr_done',
    });
  });
});

describe('documents — read isolation', () => {
  it('denies unauthenticated reads', async () => {
    await assertFails(getDoc(doc(asAnon(), 'documents/doc-a')));
  });

  it('lets a client read their own document', async () => {
    await assertSucceeds(getDoc(doc(asClient('user-a', CLIENT_A), 'documents/doc-a')));
  });

  it("denies a client reading another client's document", async () => {
    await assertFails(getDoc(doc(asClient('user-a', CLIENT_A), 'documents/doc-b')));
  });

  it('lets an accountant read any document', async () => {
    await assertSucceeds(getDoc(doc(asAccountant(), 'documents/doc-b')));
  });
});

describe('documents — client create constraints', () => {
  it('allows a well-formed web upload into the client\'s own account', async () => {
    const db = asClient('user-a', CLIENT_A);
    await assertSucceeds(
      setDoc(doc(db, 'documents/new-1'), webUploadPayload(CLIENT_A, 'user-a')),
    );
  });

  it('denies creating a document under a different clientId', async () => {
    const db = asClient('user-a', CLIENT_A);
    await assertFails(
      setDoc(doc(db, 'documents/new-2'), webUploadPayload(CLIENT_B, 'user-a')),
    );
  });

  it('denies a client pre-marking a document as processed', async () => {
    const db = asClient('user-a', CLIENT_A);
    await assertFails(
      setDoc(
        doc(db, 'documents/new-3'),
        webUploadPayload(CLIENT_A, 'user-a', { workflowStatus: 'processed' }),
      ),
    );
  });

  it('denies a client smuggling in server-owned fields (ocr)', async () => {
    const db = asClient('user-a', CLIENT_A);
    await assertFails(
      setDoc(
        doc(db, 'documents/new-4'),
        webUploadPayload(CLIENT_A, 'user-a', { ocr: { fullText: 'forged' } }),
      ),
    );
  });

  it('denies an oversized upload', async () => {
    const db = asClient('user-a', CLIENT_A);
    const payload = webUploadPayload(CLIENT_A, 'user-a');
    payload.file.sizeBytes = 60 * 1024 * 1024;
    await assertFails(setDoc(doc(db, 'documents/new-5'), payload));
  });
});

describe('documents — update constraints', () => {
  it('lets an accountant move workflowStatus', async () => {
    await assertSucceeds(
      updateDoc(doc(asAccountant(), 'documents/doc-a'), {
        workflowStatus: 'in_progress',
        updatedAt: new Date(),
      }),
    );
  });

  it('denies an accountant overwriting OCR output', async () => {
    await assertFails(
      updateDoc(doc(asAccountant(), 'documents/doc-a'), {
        ocr: { fullText: 'tampered' },
        updatedAt: new Date(),
      }),
    );
  });

  it('denies an accountant rewriting channel provenance', async () => {
    await assertFails(
      updateDoc(doc(asAccountant(), 'documents/doc-a'), {
        channel: 'gmail',
        updatedAt: new Date(),
      }),
    );
  });

  it('denies a client updating their own document', async () => {
    await assertFails(
      updateDoc(doc(asClient('user-a', CLIENT_A), 'documents/doc-a'), {
        workflowStatus: 'processed',
      }),
    );
  });

  it('denies deletes outright (soft delete is callable-only)', async () => {
    const db = asAccountant();
    await assertFails(updateDoc(doc(db, 'documents/doc-a'), { deletedAt: new Date() }));
  });
});

describe('clientIdentifiers — the mapping table is accountant-only', () => {
  it('denies a client reading the identifier map', async () => {
    await assertFails(
      getDoc(doc(asClient('user-a', CLIENT_A), 'clientIdentifiers/email:john@acme.com')),
    );
  });

  it('lets an accountant write a mapping', async () => {
    await assertSucceeds(
      setDoc(doc(asAccountant(), 'clientIdentifiers/email:john@acme.com'), {
        type: 'email',
        value: 'john@acme.com',
        clientId: CLIENT_A,
        confidence: 0.95,
        verified: true,
        source: 'manual',
        createdBy: 'acct-1',
        createdAt: new Date(),
        lastMatchedAt: null,
        matchCount: 0,
      }),
    );
  });
});

describe('metrics — read-only to accountants, never client-writable', () => {
  it('denies a client reading firm-wide metrics', async () => {
    await assertFails(getDoc(doc(asClient('user-a', CLIENT_A), 'metrics/global')));
  });

  it('denies anyone writing metrics directly', async () => {
    await assertFails(
      setDoc(doc(asAccountant(), 'metrics/global'), { counts: { pending: 999 } }),
    );
  });
});
