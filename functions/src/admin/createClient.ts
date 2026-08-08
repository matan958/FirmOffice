import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { requireAccountant } from '../lib/auth.js';
import type { ServerWrite } from '../lib/model.js';
import {
  COLLECTIONS,
  MATCH_CONFIDENCE,
  identifierKey,
  ingestAliasFrom,
  normalizeEmail,
} from '../shared.js';
import type {
  ClientDoc,
  ClientIdentifierDoc,
  CreateClientRequest,
  CreateClientResponse,
} from '../shared.js';

/**
 * Create a firm client, plus its permanent ingest alias.
 *
 * This is a callable rather than a direct client-side write (which the rules would
 * allow an accountant to make) for one reason: the alias must be globally unique, and
 * uniqueness needs to be enforced atomically. Writing /clients and
 * /clientIdentifiers in one batch with `create()` — which fails if the document
 * already exists — gets that from Firestore for free, with no read and no index.
 *
 * The alias is the top rung of the Gmail mapping ladder (confidence 1.0). Printing
 * docs+{alias}@firm.com on a client's engagement letter turns the hardest part of
 * channel ingestion into a lookup.
 */

const ALIAS_ATTEMPTS = 5;

function randomSuffix(): string {
  // 4 chars of base36 ≈ 1.7M values. Collisions are handled by retry, not avoided.
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

export const createClient = onCall<CreateClientRequest, Promise<CreateClientResponse>>(
  async (request) => {
    const caller = requireAccountant(request);
    const data = request.data ?? ({} as CreateClientRequest);

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (name.length === 0) {
      throw new HttpsError('invalid-argument', 'A client name is required.');
    }

    const clientRef = db().collection(COLLECTIONS.clients).doc();
    let ingestAlias = '';

    // Retry only the alias — the client document ID is already unique.
    for (let attempt = 0; attempt < ALIAS_ATTEMPTS; attempt++) {
      const candidate = ingestAliasFrom(name, randomSuffix());
      const aliasRef = db().doc(
        `${COLLECTIONS.clientIdentifiers}/${identifierKey('alias', candidate)}`,
      );

      const client: ServerWrite<ClientDoc> = {
        name,
        legalName: data.legalName?.trim() || null,
        taxId: data.taxId?.trim() || null,
        primaryContactEmail: data.primaryContactEmail?.trim().toLowerCase() || null,
        primaryContactPhone: data.primaryContactPhone?.trim() || null,
        ingestAlias: candidate,
        status: 'active',
        assignedAccountantIds: [],
        counters: { pending: 0, in_progress: 0, processed: 0 },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      const aliasIdentifier: ServerWrite<ClientIdentifierDoc> = {
        type: 'alias',
        value: candidate,
        clientId: clientRef.id,
        confidence: MATCH_CONFIDENCE['alias'] ?? 1.0,
        verified: true,
        source: 'seed',
        createdBy: caller.uid,
        createdAt: FieldValue.serverTimestamp(),
        lastMatchedAt: null,
        matchCount: 0,
      };

      const batch = db().batch();
      batch.create(clientRef, client);
      batch.create(aliasRef, aliasIdentifier);

      try {
        await batch.commit();
        ingestAlias = candidate;
        break;
      } catch (err: unknown) {
        // ALREADY_EXISTS (code 6) means the alias was taken between generation and
        // commit. Anything else is a real failure and must not be retried blindly.
        const code = (err as { code?: number | string })?.code;
        if (code !== 6 && code !== 'already-exists') throw err;
        logger.warn('createClient: alias collision, retrying', { candidate, attempt });
      }
    }

    if (!ingestAlias) {
      throw new HttpsError('aborted', 'Could not allocate a unique ingest alias. Try again.');
    }

    // Seed the exact-email rung too, so mail from the primary contact self-files from
    // day one. Best-effort: if another client already claims that address, the client
    // record still stands and an accountant resolves the conflict by hand.
    let emailIdentifierCreated = false;
    const email = data.primaryContactEmail?.trim();
    if (email) {
      const normalized = normalizeEmail(email);
      const emailIdentifier: ServerWrite<ClientIdentifierDoc> = {
        type: 'email',
        value: normalized,
        clientId: clientRef.id,
        confidence: MATCH_CONFIDENCE['email'] ?? 0.95,
        verified: true,
        source: 'seed',
        createdBy: caller.uid,
        createdAt: FieldValue.serverTimestamp(),
        lastMatchedAt: null,
        matchCount: 0,
      };
      try {
        await db()
          .doc(`${COLLECTIONS.clientIdentifiers}/${identifierKey('email', normalized)}`)
          .create(emailIdentifier);
        emailIdentifierCreated = true;
      } catch {
        logger.warn('createClient: email identifier already claimed', { normalized });
      }
    }

    logger.info('createClient', { actor: caller.uid, clientId: clientRef.id, ingestAlias });

    return { clientId: clientRef.id, ingestAlias, emailIdentifierCreated };
  },
);
