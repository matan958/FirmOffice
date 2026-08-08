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
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

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
function asAdmin(uid = 'admin-1') {
  return testEnv.authenticatedContext(uid, { role: 'admin' }).firestore();
}
/**
 * A client who self-registered but has NOT been linked to a client record: the token
 * carries `role: 'client'` with no clientId at all. This is the state every signup
 * lands in, so it is the one an attacker reaches for free.
 */
function asUnlinkedClient(uid = 'user-new') {
  return testEnv.authenticatedContext(uid, { role: 'client' }).firestore();
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
    // The trap an unlinked client would spring: their token has no clientId, so
    // myClientId() evaluates to '' and would match this document without the
    // isLinkedClient() guard.
    await setDoc(doc(db, 'documents/doc-empty'), {
      ...webUploadPayload('', 'user-x'),
      clientId: '',
    });
    await setDoc(doc(db, `clients/${CLIENT_A}`), {
      name: 'Acme Ltd',
      ingestAlias: 'acme7k2',
      status: 'active',
      assignedAccountantIds: [],
      counters: { pending: 0, in_progress: 0, processed: 0 },
    });
    await setDoc(doc(db, 'users/user-a'), {
      role: 'client',
      email: 'a@acme.com',
      clientId: CLIENT_A,
      active: true,
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
  it('lets an accountant move workflowStatus when they claim it as themselves', async () => {
    await assertSucceeds(
      updateDoc(doc(asAccountant('acct-1'), 'documents/doc-a'), {
        workflowStatus: 'in_progress',
        statusActorUid: 'acct-1',
        updatedAt: new Date(),
      }),
    );
  });

  it('denies a status change with no actor recorded', async () => {
    // Otherwise the audit trail says `system` and "who marked this processed" — a
    // question a CPA firm eventually has to answer — has no answer.
    await assertFails(
      updateDoc(doc(asAccountant('acct-1'), 'documents/doc-a'), {
        workflowStatus: 'processed',
        updatedAt: new Date(),
      }),
    );
  });

  it("denies attributing a status change to a colleague", async () => {
    // The whole reason the field is trustworthy: it is pinned to the caller's uid.
    await assertFails(
      updateDoc(doc(asAccountant('acct-1'), 'documents/doc-a'), {
        workflowStatus: 'processed',
        statusActorUid: 'acct-2',
        updatedAt: new Date(),
      }),
    );
  });

  it('allows reassigning a client without an actor, since status did not move', async () => {
    await assertSucceeds(
      updateDoc(doc(asAccountant('acct-1'), 'documents/doc-a'), {
        clientId: CLIENT_B,
        clientNameCache: 'Globex',
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

describe('unlinked client — signup grants a role but no access', () => {
  it('denies reading any client document', async () => {
    await assertFails(getDoc(doc(asUnlinkedClient(), 'documents/doc-a')));
  });

  it("denies reading a document whose clientId is the empty string", async () => {
    // Without isLinkedClient(), myClientId() === '' would match this exactly.
    await assertFails(getDoc(doc(asUnlinkedClient(), 'documents/doc-empty')));
  });

  it('denies creating a document under the empty clientId', async () => {
    await assertFails(
      setDoc(doc(asUnlinkedClient(), 'documents/new-unlinked'), {
        ...webUploadPayload('', 'user-new'),
        clientId: '',
      }),
    );
  });

  it('denies reading any client record', async () => {
    await assertFails(getDoc(doc(asUnlinkedClient(), `clients/${CLIENT_A}`)));
  });
});

describe('users — self-readable mirror, never client-writable', () => {
  it('lets a user read their own mirror', async () => {
    await assertSucceeds(getDoc(doc(asClient('user-a', CLIENT_A), 'users/user-a')));
  });

  it("denies reading another user's mirror", async () => {
    await assertFails(getDoc(doc(asClient('user-b', CLIENT_B), 'users/user-a')));
  });

  it('lets an admin read any mirror', async () => {
    await assertSucceeds(getDoc(doc(asAdmin(), 'users/user-a')));
  });

  it('denies an accountant reading an arbitrary mirror', async () => {
    // Accountants get blanket document access, but roles are an admin concern.
    await assertFails(getDoc(doc(asAccountant(), 'users/user-a')));
  });

  it('denies a user writing their own role', async () => {
    // The whole point: privilege escalation must go through setUserRole, which
    // checks the caller is an admin. Custom claims are set by the Admin SDK only.
    await assertFails(
      setDoc(doc(asClient('user-a', CLIENT_A), 'users/user-a'), { role: 'admin' }),
    );
  });
});

describe('clients — accountant-managed, client sees only their own', () => {
  it('lets a linked client read their own record', async () => {
    await assertSucceeds(getDoc(doc(asClient('user-a', CLIENT_A), `clients/${CLIENT_A}`)));
  });

  it("denies a client reading another firm client's record", async () => {
    await assertFails(getDoc(doc(asClient('user-a', CLIENT_A), `clients/${CLIENT_B}`)));
  });

  it('lets an accountant create a client', async () => {
    await assertSucceeds(
      setDoc(doc(asAccountant(), 'clients/client-new'), {
        name: 'New Co',
        ingestAlias: 'newco1',
        status: 'active',
        assignedAccountantIds: [],
        counters: { pending: 0, in_progress: 0, processed: 0 },
      }),
    );
  });

  it('denies a client creating a client record', async () => {
    await assertFails(
      setDoc(doc(asClient('user-a', CLIENT_A), 'clients/client-forged'), { name: 'Forged' }),
    );
  });

  it('denies hard-deleting a client (archive via status instead)', async () => {
    await assertFails(deleteDoc(doc(asAdmin(), `clients/${CLIENT_A}`)));
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
