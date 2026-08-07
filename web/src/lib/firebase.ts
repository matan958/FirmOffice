import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { FUNCTIONS_REGION } from '@shared';

/**
 * Firebase Web SDK singletons.
 *
 * When VITE_USE_EMULATORS is "true" every service is redirected to the local
 * emulator suite. The guard is deliberately explicit rather than keying off
 * import.meta.env.DEV, so a preview build cannot silently talk to emulators — or,
 * worse, a dev session cannot silently write to production Firestore.
 */

const requiredKeys = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_APP_ID',
] as const;

const missing = requiredKeys.filter((k) => !import.meta.env[k]);
if (missing.length > 0) {
  // Fail loudly at boot rather than with an opaque SDK error five screens later.
  throw new Error(
    `Missing Firebase config: ${missing.join(', ')}.\n` +
      `Copy web/.env.example to web/.env.local and fill it in.`,
  );
}

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, FUNCTIONS_REGION);

export const usingEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

if (usingEmulators) {
  const host = '127.0.0.1';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectStorageEmulator(storage, host, 9199);
  connectFunctionsEmulator(functions, host, 5001);
  // eslint-disable-next-line no-console
  console.info('[firmoffice] Connected to the local Firebase emulator suite.');
}
