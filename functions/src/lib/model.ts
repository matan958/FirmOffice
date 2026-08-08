import type { FieldValue } from 'firebase-admin/firestore';
import type { Timestampish } from '../shared.js';

/**
 * A canonical model type as the SERVER writes it.
 *
 * `shared/` describes documents as they are READ — every timestamp is a real
 * Timestamp. But a server write usually supplies `FieldValue.serverTimestamp()`
 * instead, and increments arrive as `FieldValue.increment()`. Rather than casting at
 * every call site (which quietly disables checking on the other fields too), this maps
 * the timestamp fields to accept the sentinel and leaves everything else strict.
 *
 *   db().doc(...).set(mirror satisfies Partial<ServerWrite<UserDoc>>)
 */
export type ServerWrite<T> = {
  [K in keyof T]: T[K] extends Timestampish | null | undefined
    ? T[K] | FieldValue
    : T[K];
};
