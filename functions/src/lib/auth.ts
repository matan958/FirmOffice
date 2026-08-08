import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { Role } from '../shared.js';

/**
 * Callable authorization guards.
 *
 * These read the SAME custom claims the security rules read, so a callable and a
 * direct Firestore write can never disagree about who someone is. The Admin SDK
 * bypasses rules entirely, which is exactly why every callable must gate itself here
 * rather than assuming the client was already checked.
 */

export interface Caller {
  uid: string;
  /** Null for a freshly signed-up user whose claims have not been set yet. */
  role: Role | null;
  /** Non-null only once an accountant has linked this client to a /clients record. */
  clientId: string | null;
}

const ROLES: readonly Role[] = ['client', 'accountant', 'admin'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Reads the caller out of the verified ID token. Never trusts request data. */
export function callerOf(request: CallableRequest<unknown>): Caller {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const token = request.auth.token as Record<string, unknown>;
  const clientId = token['clientId'];
  return {
    uid: request.auth.uid,
    role: isRole(token['role']) ? token['role'] : null,
    clientId: typeof clientId === 'string' && clientId.length > 0 ? clientId : null,
  };
}

export function requireAdmin(request: CallableRequest<unknown>): Caller {
  const caller = callerOf(request);
  if (caller.role !== 'admin') {
    // Deliberately not "you are a client" — do not narrate the permission model to
    // someone probing it.
    throw new HttpsError('permission-denied', 'Administrator access required.');
  }
  return caller;
}

export function requireAccountant(request: CallableRequest<unknown>): Caller {
  const caller = callerOf(request);
  if (caller.role !== 'accountant' && caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Accountant access required.');
  }
  return caller;
}
