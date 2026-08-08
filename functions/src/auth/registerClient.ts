import { onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db } from '../lib/firebase.js';
import { callerOf } from '../lib/auth.js';
import type { ServerWrite } from '../lib/model.js';
import { COLLECTIONS } from '../shared.js';
import type { AuthClaims, RegisterClientResponse, UserDoc } from '../shared.js';

/**
 * Provision a freshly signed-up user as an UNLINKED client.
 *
 * Firebase Auth account creation happens client-side, which means the new user holds
 * a token with no role at all. This is what fills that gap. Gen 2 has no auth
 * onCreate trigger — only Identity-Platform blocking functions, which need a GCIP
 * upgrade — and a callable is better here anyway: it is synchronous, so the SPA knows
 * exactly when to force a token refresh.
 *
 * Two properties matter:
 *
 *  - **Idempotent.** A caller who already holds a role gets it echoed back untouched.
 *    That lets the SPA call this whenever it sees a role-less token without risking a
 *    demotion of an accountant whose token merely lagged.
 *  - **Unlinked.** It grants `role: 'client'` with NO clientId claim. The rules gate
 *    every client read and write on a non-empty clientId, so a stranger who signs up
 *    can reach nothing until an accountant links them via setUserRole.
 */
export const registerClient = onCall<void, Promise<RegisterClientResponse>>(async (request) => {
  const caller = callerOf(request);

  if (caller.role !== null) {
    return {
      role: caller.role,
      clientId: caller.clientId,
      active: caller.clientId !== null || caller.role !== 'client',
      created: false,
    };
  }

  const user = await auth().getUser(caller.uid);
  const claims: AuthClaims = { role: 'client' };
  await auth().setCustomUserClaims(caller.uid, claims);

  const mirror: Partial<ServerWrite<UserDoc>> = {
    role: 'client',
    email: user.email ?? '',
    displayName: user.displayName ?? null,
    photoURL: user.photoURL ?? null,
    clientId: null,
    // Not usable yet: an accountant still has to link them to a /clients record.
    active: false,
    createdAt: FieldValue.serverTimestamp(),
    lastLoginAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db().doc(`${COLLECTIONS.users}/${caller.uid}`).set(mirror, { merge: true });

  logger.info('registerClient', { uid: caller.uid, email: user.email });

  return { role: 'client', clientId: null, active: false, created: true };
});
