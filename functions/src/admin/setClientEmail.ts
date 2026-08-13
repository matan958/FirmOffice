import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { requireAccountant } from '../lib/auth.js';
import { backfill } from './linkIdentifier.js';
import type { ServerWrite } from '../lib/model.js';
import { COLLECTIONS, MATCH_CONFIDENCE, identifierKey, normalizeEmail } from '../shared.js';
import type {
  ClientDoc,
  ClientIdentifierDoc,
  SetClientEmailRequest,
  SetClientEmailResponse,
} from '../shared.js';

/**
 * Sets the address a client's mail is recognised by.
 *
 * This is now THE identifier: a document from this address files itself against this
 * client, and a document from anywhere else waits in Unassigned. So the field cannot
 * stay what it was — write-once at creation, invisible afterwards — because a mistyped
 * address would mean a client whose mail never files, with nothing on screen to say why
 * and no way to correct it short of recreating them.
 *
 * A callable rather than a direct write, because "change the email" is three writes that
 * have to agree:
 *
 *   1. the client record,
 *   2. the OLD `email:` row — which, left behind, keeps filing mail from an address the
 *      client has stopped using, forever and invisibly,
 *   3. the NEW row, which another client may already own.
 *
 * A browser doing this in three separate updates can leave any pair of them applied.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const setClientEmail = onCall<SetClientEmailRequest, Promise<SetClientEmailResponse>>(
  async (request) => {
    const caller = requireAccountant(request);
    const clientId = request.data?.clientId;
    const raw = typeof request.data?.email === 'string' ? request.data.email.trim() : '';

    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new HttpsError('invalid-argument', 'clientId is required.');
    }

    const clientRef = db().doc(`${COLLECTIONS.clients}/${clientId}`);
    const clientSnap = await clientRef.get();
    if (!clientSnap.exists) throw new HttpsError('not-found', 'That client does not exist.');
    const client = clientSnap.data() as ClientDoc;

    // Normalized with the SAME function the resolver uses, or the row is dead on
    // arrival: it would sit in the table looking correct and never match anything.
    const next = raw === '' ? null : normalizeEmail(raw);
    if (next !== null && !EMAIL_RE.test(next)) {
      throw new HttpsError('invalid-argument', `"${raw}" is not an email address.`);
    }

    const previous = client.primaryContactEmail ? normalizeEmail(client.primaryContactEmail) : null;
    const keyFor = (value: string) =>
      db().doc(`${COLLECTIONS.clientIdentifiers}/${identifierKey('email', value)}`);

    // Reported, never taken. Re-pointing an address moves every future document from
    // that sender to a different client, which someone should decide on purpose after
    // seeing who holds it now — not discover weeks later from a misfiled invoice.
    if (next) {
      const existing = await keyFor(next).get();
      if (existing.exists) {
        const owner = (existing.data() as ClientIdentifierDoc).clientId;
        if (owner !== clientId) {
          const ownerSnap = await db().doc(`${COLLECTIONS.clients}/${owner}`).get();
          logger.warn('setClientEmail: address already claimed', { next, owner, clientId });
          return {
            clientId,
            email: client.primaryContactEmail,
            conflictWithClientId: owner,
            conflictWithClientName: ownerSnap.exists
              ? ((ownerSnap.data() as ClientDoc).name ?? owner)
              : owner,
            backfilled: 0,
          };
        }
      }
    }

    const batch = db().batch();

    // Remove the old row only if it still belongs to THIS client. If it has since been
    // re-pointed elsewhere, deleting it here would silently break that other client.
    if (previous && previous !== next) {
      const oldRef = keyFor(previous);
      const oldSnap = await oldRef.get();
      if (oldSnap.exists && (oldSnap.data() as ClientIdentifierDoc).clientId === clientId) {
        batch.delete(oldRef);
      }
    }

    if (next) {
      const identifier: ServerWrite<ClientIdentifierDoc> = {
        type: 'email',
        value: next,
        clientId,
        confidence: MATCH_CONFIDENCE['email'] ?? 0.95,
        verified: true,
        source: 'manual',
        createdBy: caller.uid,
        createdAt: FieldValue.serverTimestamp(),
        lastMatchedAt: null,
        matchCount: 0,
      };
      // set(), not create(): re-saving the same address must be idempotent rather than
      // an error an accountant has to interpret.
      batch.set(keyFor(next), identifier, { merge: true });
    }

    batch.update(clientRef, {
      primaryContactEmail: next,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // Documents already waiting from this sender. Without this the correction only
    // helps future mail, and the pile that prompted it stays in Unassigned — which
    // reads as the fix not having worked.
    const backfilled = next
      ? await backfill('email', next, clientId, client.name ?? null, caller.uid).catch(
          (err: unknown) => {
            logger.warn('setClientEmail: backfill failed', { clientId, err: String(err) });
            return 0;
          },
        )
      : 0;

    logger.info('setClientEmail', { actor: caller.uid, clientId, next, backfilled });
    return { clientId, email: next, backfilled };
  },
);
