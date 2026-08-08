import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db } from '../lib/firebase.js';
import { isRole, requireAdmin } from '../lib/auth.js';
import type { ServerWrite } from '../lib/model.js';
import { COLLECTIONS } from '../shared.js';
import type { AuthClaims, SetUserRoleRequest, SetUserRoleResponse, UserDoc } from '../shared.js';

/**
 * Grant or change a user's role. Admin-only — this is how accountants are created,
 * since there is no self-signup path to anything but an unlinked client.
 *
 * Also the mechanism that ACTIVATES a self-registered client: it attaches the
 * `clientId` claim, without which the security rules let them see nothing.
 */
export const setUserRole = onCall<SetUserRoleRequest, Promise<SetUserRoleResponse>>(
  async (request) => {
    const caller = requireAdmin(request);
    const { uid, role, clientId } = request.data ?? ({} as SetUserRoleRequest);

    if (typeof uid !== 'string' || uid.length === 0) {
      throw new HttpsError('invalid-argument', 'uid is required.');
    }
    if (!isRole(role)) {
      throw new HttpsError('invalid-argument', `role must be one of client, accountant, admin.`);
    }

    // An admin who demotes themselves cannot undo it — setUserRole is the only way
    // back and it requires the role they just gave up. If they are the sole admin the
    // project needs the bootstrap script again.
    if (uid === caller.uid && role !== 'admin') {
      throw new HttpsError(
        'failed-precondition',
        'You cannot change your own role. Ask another administrator.',
      );
    }

    // A client without a clientId can reach nothing, so silently allowing it would
    // look like a broken activation rather than a rejected one.
    let linkedClientId: string | null = null;
    if (role === 'client') {
      if (typeof clientId !== 'string' || clientId.length === 0) {
        throw new HttpsError('invalid-argument', 'clientId is required when role is "client".');
      }
      const clientSnap = await db().doc(`${COLLECTIONS.clients}/${clientId}`).get();
      if (!clientSnap.exists) {
        throw new HttpsError('not-found', `No client record ${clientId}.`);
      }
      linkedClientId = clientId;
    }

    const user = await auth()
      .getUser(uid)
      .catch(() => {
        throw new HttpsError('not-found', `No user account ${uid}.`);
      });

    // Claims are capped at 1000 bytes in total, so keep this to the two fields the
    // rules actually read. Accountants get blanket access rather than a client list.
    const claims: AuthClaims = linkedClientId
      ? { role, clientId: linkedClientId }
      : { role };
    await auth().setCustomUserClaims(uid, claims);

    const mirror: Partial<ServerWrite<UserDoc>> = {
      role,
      email: user.email ?? '',
      displayName: user.displayName ?? null,
      photoURL: user.photoURL ?? null,
      clientId: linkedClientId,
      active: true,
      updatedAt: FieldValue.serverTimestamp(),
    };
    await db()
      .doc(`${COLLECTIONS.users}/${uid}`)
      .set({ createdAt: FieldValue.serverTimestamp(), ...mirror }, { merge: true });

    // Existing ID tokens keep the OLD claims until they expire — up to an hour. For a
    // demotion that is a real authorization gap, so revoke rather than wait it out.
    // The SPA still calls getIdToken(true) itself; this covers every other session.
    await auth().revokeRefreshTokens(uid);

    logger.info('setUserRole', { actor: caller.uid, target: uid, role, clientId: linkedClientId });

    return { uid, role, clientId: linkedClientId, tokensRevoked: true };
  },
);
