import type { FieldValue } from 'firebase-admin/firestore';
import type { Timestampish } from '../shared.js';

/**
 * A canonical model type as the SERVER writes it.
 *
 * `shared/` describes documents as they are READ — every timestamp is a real
 * Timestamp. But a server write usually supplies `FieldValue.serverTimestamp()`
 * instead, and counters arrive as `FieldValue.increment()`. Rather than casting at
 * every call site (which quietly disables checking on the other fields too), this maps
 * those fields to accept the sentinel and leaves everything else strict.
 *
 *   db().doc(...).set(mirror satisfies Partial<ServerWrite<UserDoc>>)
 *
 * Recursive, because the sentinels appear inside nested maps too — `clientMatch`
 * holds a `resolvedAt`, and a shallow mapping forces a cast of the whole enclosing
 * object, which is precisely the checking this type exists to preserve.
 *
 * Arrays are passed through untouched: mapping over one would rewrite its own `length`
 * and methods rather than its elements, and no array field here holds a sentinel.
 */
type Writable<V> = V extends Timestampish
  ? V | FieldValue
  : V extends readonly unknown[]
    ? V
    : V extends number
      ? // FieldValue.increment() — the only correct way to move a counter that two
        // invocations may touch at once. An absolute write silently loses one of them.
        V | FieldValue
      : V extends object
        ? { [K in keyof V]: Writable<V[K]> }
        : V;

export type ServerWrite<T> = { [K in keyof T]: Writable<T[K]> };
