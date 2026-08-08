import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { requireAccountant } from '../lib/auth.js';
import type { ServerWrite } from '../lib/model.js';
import {
  COLLECTIONS,
  MATCH_CONFIDENCE,
  PUBLIC_EMAIL_DOMAINS,
  SUBJECT_CODE_RE,
  identifierKey,
  normalizeEmail,
} from '../shared.js';
import type {
  ClientDoc,
  ClientIdentifierDoc,
  DocumentDoc,
  GmailSource,
  IdentifierType,
  LinkIdentifierRequest,
  LinkIdentifierResponse,
} from '../shared.js';

/**
 * The learning loop: "always file mail from john@acme.com under Acme Ltd".
 *
 * This is what decides whether the Unassigned queue is a short onboarding phase or a
 * permanent tax. Every document an accountant files by hand can teach the ladder one
 * identifier, so the manual work trends toward zero instead of recurring forever.
 *
 * It is a callable rather than a direct write — which the rules would permit — for
 * three reasons, in ascending order of importance: the key must be normalized exactly
 * as the resolver normalizes it or the row is dead on arrival; the public-domain
 * blocklist must be enforced at the point of creation, not only at match time; and
 * ticking the box should re-file the documents ALREADY sitting in the queue from that
 * sender, which is the difference between a feature that feels useful and one that
 * feels like paperwork.
 */

/** How many previously-unassigned documents one tick will re-file. */
const BACKFILL_SCAN_LIMIT = 300;

function normalizeValue(type: IdentifierType, raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  switch (type) {
    case 'email':
      return normalizeEmail(trimmed);
    case 'domain':
      // Accept a whole address here — an accountant looking at "john@acme.com" and
      // choosing "this domain" should not have to retype the domain part.
      return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed;
    default:
      return trimmed;
  }
}

function validate(type: IdentifierType, value: string): void {
  if (value.length === 0) {
    throw new HttpsError('invalid-argument', 'The identifier value is empty.');
  }
  if (type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new HttpsError('invalid-argument', `"${value}" is not an email address.`);
  }
  if (type === 'domain') {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) {
      throw new HttpsError('invalid-argument', `"${value}" is not a domain.`);
    }
    // The single most damaging row this table can hold. It is also the easiest to
    // create by accident: a client who uses a personal Gmail address, an accountant
    // ticking "always file from this domain", and now every Gmail user on earth maps
    // to that client. The resolver refuses to match these too — this is the earlier
    // of the two guards, and the one that produces an explanation.
    if (PUBLIC_EMAIL_DOMAINS.has(value)) {
      throw new HttpsError(
        'invalid-argument',
        `${value} is a public mailbox provider, so a domain rule would match every ` +
          `one of its users. Map the individual address instead.`,
      );
    }
  }
  if (type === 'subjectCode' && !SUBJECT_CODE_RE.test(`[${value}]`)) {
    throw new HttpsError(
      'invalid-argument',
      'A subject code must be 2–32 letters, digits, hyphens or underscores.',
    );
  }
  if (type === 'phone') {
    throw new HttpsError('invalid-argument', 'Phone identifiers arrive with WhatsApp (M5).');
  }
}

/**
 * Re-files unassigned documents this identifier would now have matched.
 *
 * Scans the Unassigned queue and filters in memory rather than querying on the
 * identifier: `source.from` is stored as it arrived, so the normalized form the
 * mapping table is keyed on does not exist as a queryable field. Firestore cannot
 * index a computed value, and denormalizing one onto every document to serve an
 * occasional backfill would be the wrong trade.
 */
async function backfill(
  type: IdentifierType,
  value: string,
  clientId: string,
  clientNameCache: string | null,
  actorUid: string,
): Promise<number> {
  if (type !== 'email' && type !== 'domain') return 0;

  const snap = await db()
    .collection(COLLECTIONS.documents)
    .where('clientId', '==', null)
    .orderBy('receivedAt', 'desc')
    .limit(BACKFILL_SCAN_LIMIT)
    .get();

  const matches = snap.docs.filter((d) => {
    const doc = d.data() as DocumentDoc;
    if (doc.channel !== 'gmail' || doc.deletedAt) return false;
    const from = (doc.source as GmailSource).from;
    if (!from) return false;
    const normalized = normalizeEmail(from);
    return type === 'email'
      ? normalized === value
      : normalized.endsWith(`@${value}`);
  });

  if (matches.length === 0) return 0;

  const batch = db().batch();
  for (const hit of matches) {
    batch.update(hit.ref, {
      clientId,
      clientNameCache,
      clientMatch: {
        method: 'manual',
        confidence: MATCH_CONFIDENCE['manual'] ?? 1,
        matchedIdentifier: identifierKey(type, value),
        resolvedBy: actorUid,
        resolvedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  return matches.length;
}

export const linkIdentifier = onCall<LinkIdentifierRequest, Promise<LinkIdentifierResponse>>(
  async (request) => {
    const caller = requireAccountant(request);
    const data = request.data ?? ({} as LinkIdentifierRequest);

    const type = data.type;
    if (!type || typeof data.value !== 'string' || typeof data.clientId !== 'string') {
      throw new HttpsError('invalid-argument', 'type, value and clientId are required.');
    }

    const value = normalizeValue(type, data.value);
    validate(type, value);

    const clientSnap = await db().doc(`${COLLECTIONS.clients}/${data.clientId}`).get();
    if (!clientSnap.exists) {
      throw new HttpsError('not-found', 'That client does not exist.');
    }
    const name = (clientSnap.data() as ClientDoc).name ?? null;

    const key = identifierKey(type, value);
    const ref = db().doc(`${COLLECTIONS.clientIdentifiers}/${key}`);
    const existing = await ref.get();

    if (existing.exists) {
      const owner = (existing.data() as ClientIdentifierDoc).clientId;
      if (owner !== data.clientId) {
        // Reported, never silently rewritten. Re-pointing an identifier moves every
        // future document from that sender to a different client, which is a decision
        // someone should make on purpose after seeing who holds it now.
        logger.warn('linkIdentifier: conflict', { key, owner, requested: data.clientId });
        return { key, clientId: owner, created: false, conflictWithClientId: owner, backfilled: 0 };
      }
      // Already points where it was asked to. Backfill is still worth running: the
      // identifier may have been created after those documents arrived.
      const backfilled = data.backfill
        ? await backfill(type, value, data.clientId, name, caller.uid)
        : 0;
      return { key, clientId: owner, created: false, backfilled };
    }

    const identifier: ServerWrite<ClientIdentifierDoc> = {
      type,
      value,
      clientId: data.clientId,
      confidence: MATCH_CONFIDENCE[type] ?? 0.6,
      verified: true,
      source: 'manual',
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      lastMatchedAt: null,
      matchCount: 0,
    };

    try {
      await ref.create(identifier);
    } catch (err: unknown) {
      const code = (err as { code?: number | string })?.code;
      if (code !== 6 && code !== 'already-exists') throw err;
      // Lost a race with a concurrent tick of the same checkbox.
      const now = await ref.get();
      const owner = (now.data() as ClientIdentifierDoc).clientId;
      return {
        key,
        clientId: owner,
        created: false,
        ...(owner === data.clientId ? {} : { conflictWithClientId: owner }),
        backfilled: 0,
      };
    }

    const backfilled = data.backfill
      ? await backfill(type, value, data.clientId, name, caller.uid)
      : 0;

    logger.info('linkIdentifier', { actor: caller.uid, key, clientId: data.clientId, backfilled });
    return { key, clientId: data.clientId, created: true, backfilled };
  },
);
