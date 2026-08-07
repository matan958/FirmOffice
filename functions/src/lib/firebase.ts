import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth, type Auth } from 'firebase-admin/auth';

/**
 * Admin SDK singletons.
 *
 * Cloud Functions reuses a warm instance across invocations, so initialization must
 * be idempotent — calling initializeApp() twice throws. Accessors are lazy so that
 * merely importing a module (as the Functions loader does when discovering exports)
 * never opens a connection.
 */

let app: App | undefined;

function getApp(): App {
  if (!app) {
    app = getApps().length ? getApps()[0]! : initializeApp();
  }
  return app;
}

let firestore: Firestore | undefined;

export function db(): Firestore {
  if (!firestore) {
    firestore = getFirestore(getApp());
    // Treat `undefined` as "leave the field alone" rather than throwing. Without
    // this, every optional field has to be conditionally spread at each call site.
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore;
}

export function auth(): Auth {
  return getAuth(getApp());
}

export function bucket() {
  return getStorage(getApp()).bucket();
}

/** True when running under `firebase emulators:start`. */
export const isEmulated = process.env.FUNCTIONS_EMULATOR === 'true';
