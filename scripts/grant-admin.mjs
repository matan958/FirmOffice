#!/usr/bin/env node
/**
 * Grants the `admin` role to a user, by email.
 *
 * This exists to break a chicken-and-egg: `setUserRole` is the way roles are assigned,
 * but it is admin-only, and a fresh project has no admin. This script uses the Admin
 * SDK directly — which bypasses both the callable's guard and the security rules — to
 * mint the first one. After that, admins promote each other through the app.
 *
 * Against the emulator suite (start `npm run emulators` first):
 *   node scripts/grant-admin.mjs you@example.com --emulator
 *
 * Against the real project (needs `gcloud auth application-default login`):
 *   node scripts/grant-admin.mjs you@example.com
 *
 * The user must already exist — sign up through the app first, then run this.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = resolve(HERE, '..');

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('-'));
const useEmulator = args.includes('--emulator');

if (!email) {
  console.error('Usage: node scripts/grant-admin.mjs <email> [--emulator]');
  process.exit(1);
}

let projectId = process.env.GCLOUD_PROJECT;
if (!projectId) {
  const { projects } = JSON.parse(readFileSync(resolve(root, '.firebaserc'), 'utf8'));
  projectId = projects?.default;
}

if (useEmulator) {
  // The emulator ignores credentials entirely, so a placeholder project ID is fine —
  // and `demo-` prefixed IDs are recognised as offline-only, which makes it impossible
  // for this run to touch a real project by accident.
  projectId =
    projectId && !projectId.startsWith('REPLACE_WITH') ? projectId : 'demo-firmoffice';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
} else if (!projectId || projectId.startsWith('REPLACE_WITH')) {
  console.error('Set your project ID in .firebaserc first (or export GCLOUD_PROJECT).');
  process.exit(1);
}

initializeApp({ projectId });

const auth = getAuth();
const db = getFirestore();

const user = await auth.getUserByEmail(email).catch(() => null);
if (!user) {
  console.error(
    `No account for ${email} in project ${projectId}.\n` +
      `Sign up through the app first, then re-run this.`,
  );
  process.exit(1);
}

await auth.setCustomUserClaims(user.uid, { role: 'admin' });

await db.doc(`users/${user.uid}`).set(
  {
    role: 'admin',
    email: user.email ?? email,
    displayName: user.displayName ?? null,
    photoURL: user.photoURL ?? null,
    clientId: null,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastLoginAt: null,
  },
  { merge: true },
);

// Their current ID token still says whatever it said before, for up to an hour.
await auth.revokeRefreshTokens(user.uid);

console.log(`${email} (${user.uid}) is now an admin in ${projectId}.`);
console.log('Sign out and back in — the old ID token still carries the previous role.');
