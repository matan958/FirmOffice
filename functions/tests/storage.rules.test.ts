import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

/**
 * Cloud Storage security rules tests.
 *
 * The Client Portal writes bytes straight to the bucket from the browser, so these
 * rules are the only thing standing between a signed-in client and someone else's
 * prefix. Firestore rules cannot help here — different service, different evaluator.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(resolve(HERE, '../../storage.rules'), 'utf8');

const CLIENT_A = 'client-acme';
const CLIENT_B = 'client-globex';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7

let testEnv: RulesTestEnvironment;

function asClient(uid: string, clientId: string) {
  return testEnv.authenticatedContext(uid, { role: 'client', clientId }).storage();
}
/** Signed up, not yet linked to a client record — no clientId claim at all. */
function asUnlinkedClient(uid = 'user-new') {
  return testEnv.authenticatedContext(uid, { role: 'client' }).storage();
}
function asAccountant(uid = 'acct-1') {
  return testEnv.authenticatedContext(uid, { role: 'accountant' }).storage();
}
function asAnon() {
  return testEnv.unauthenticatedContext().storage();
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-firmoffice',
    storage: { rules: RULES, host: '127.0.0.1', port: 9199 },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

describe('incoming/ — client uploads', () => {
  it('lets a linked client upload into their own prefix', async () => {
    const s = asClient('user-a', CLIENT_A);
    await assertSucceeds(
      uploadBytes(ref(s, `incoming/${CLIENT_A}/doc1/invoice.pdf`), PDF, {
        contentType: 'application/pdf',
      }),
    );
  });

  it("denies uploading into another client's prefix", async () => {
    const s = asClient('user-a', CLIENT_A);
    await assertFails(
      uploadBytes(ref(s, `incoming/${CLIENT_B}/doc1/invoice.pdf`), PDF, {
        contentType: 'application/pdf',
      }),
    );
  });

  it('denies an unlinked client uploading into a real client prefix', async () => {
    // Their token has no clientId, so myClientId() is '' and can never equal a real
    // prefix. Deliberately NOT asserted against `incoming//doc1/...`: an empty path
    // segment is not a reachable object path, so such a test would pass even with the
    // rule removed — it would be testing the SDK, not the rules.
    const s = asUnlinkedClient();
    await assertFails(
      uploadBytes(ref(s, `incoming/${CLIENT_A}/doc1/invoice.pdf`), PDF, {
        contentType: 'application/pdf',
      }),
    );
  });

  it('denies an unauthenticated upload', async () => {
    await assertFails(
      uploadBytes(ref(asAnon(), `incoming/${CLIENT_A}/doc1/invoice.pdf`), PDF, {
        contentType: 'application/pdf',
      }),
    );
  });

  it('denies a disallowed content type', async () => {
    const s = asClient('user-a', CLIENT_A);
    await assertFails(
      uploadBytes(ref(s, `incoming/${CLIENT_A}/doc1/evil.svg`), PDF, {
        // SVG is a stored-XSS vector aimed at whoever opens it later.
        contentType: 'image/svg+xml',
      }),
    );
  });

  it('denies an empty file', async () => {
    const s = asClient('user-a', CLIENT_A);
    await assertFails(
      uploadBytes(ref(s, `incoming/${CLIENT_A}/doc1/empty.pdf`), new Uint8Array(0), {
        contentType: 'application/pdf',
      }),
    );
  });

  it('denies an accountant uploading on a client\'s behalf', async () => {
    // Accountants have no client prefix of their own; ingestion is server-side.
    await assertFails(
      uploadBytes(ref(asAccountant(), `incoming/${CLIENT_A}/doc1/x.pdf`), PDF, {
        contentType: 'application/pdf',
      }),
    );
  });
});

describe('reads — nobody, ever', () => {
  it('denies a client reading back their own upload', async () => {
    // Previews come from short-lived signed URLs minted by getDocumentUrl, which
    // records who looked at what. Direct bucket reads would bypass that audit trail.
    await assertFails(
      getDownloadURL(ref(asClient('user-a', CLIENT_A), `incoming/${CLIENT_A}/doc1/invoice.pdf`)),
    );
  });

  it('denies an accountant reading the bucket directly', async () => {
    await assertFails(
      getDownloadURL(ref(asAccountant(), `incoming/${CLIENT_A}/doc1/invoice.pdf`)),
    );
  });

  it('denies reading server-only prefixes', async () => {
    await assertFails(getDownloadURL(ref(asAccountant(), 'ocr-text/doc1/fulltext.txt')));
    await assertFails(getDownloadURL(ref(asAccountant(), 'quarantine/doc1/bad.pdf')));
  });
});
