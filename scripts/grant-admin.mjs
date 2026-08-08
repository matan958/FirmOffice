#!/usr/bin/env node
/**
 * Grants the `admin` role to a user, by email.
 *
 * This exists to break a chicken-and-egg: `setUserRole` is the way roles are assigned,
 * but it is admin-only, and a fresh project has no admin. This script talks to the
 * Admin APIs directly — bypassing both the callable's guard and the security rules —
 * to mint the first one. After that, admins promote each other through the app.
 *
 * Against the emulator suite (start `npm run emulators` first):
 *   node scripts/grant-admin.mjs you@example.com --emulator
 *
 * Against the real project — no gcloud needed, just `npx firebase login`:
 *   node scripts/grant-admin.mjs you@example.com
 *
 * The user must already exist: sign up through the app first, then run this.
 *
 * ── Why Firestore goes through REST ──
 * The Admin SDK's Firestore client REFUSES a refreshToken credential ("Must initialize
 * the SDK with a certificate credential or application default credentials"). Its Auth
 * client accepts one happily. Rather than force a gcloud install or a service-account
 * key file — a real secret to look after — the profile write goes over the Firestore
 * REST API, which the same OAuth token authorizes fine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { initializeApp, refreshToken } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = resolve(HERE, '..');

// The public OAuth client shipped inside firebase-tools itself.
const CLI_CLIENT_ID =
  '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

function storedRefreshToken() {
  for (const p of [
    join(process.env.APPDATA ?? '', 'configstore', 'firebase-tools.json'),
    join(homedir(), '.config', 'configstore', 'firebase-tools.json'),
  ]) {
    if (!p || !existsSync(p)) continue;
    const stored = JSON.parse(readFileSync(p, 'utf8'));
    if (stored?.tokens?.refresh_token) return stored.tokens.refresh_token;
  }
  throw new Error('Not logged in. Run `npx firebase login` first.');
}

async function accessToken(refresh) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLI_CLIENT_ID,
      client_secret: CLI_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

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
  // `demo-` prefixed IDs are recognised by the emulator suite as offline-only, so this
  // run cannot touch a real project by accident.
  projectId = projectId && !projectId.startsWith('REPLACE_WITH') ? projectId : 'demo-firmoffice';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
} else if (!projectId || projectId.startsWith('REPLACE_WITH')) {
  console.error('Set your project ID in .firebaserc first (or export GCLOUD_PROJECT).');
  process.exit(1);
}

const refresh = useEmulator ? null : storedRefreshToken();
const token = useEmulator ? null : await accessToken(refresh);

initializeApp(
  useEmulator
    ? { projectId }
    : {
        projectId,
        credential: refreshToken({
          type: 'authorized_user',
          client_id: CLI_CLIENT_ID,
          client_secret: CLI_CLIENT_SECRET,
          refresh_token: refresh,
        }),
      },
);

const auth = getAuth();

// Only user-not-found means "sign up first". Swallowing every error here once turned
// an authentication failure into a confidently wrong "no such account" message.
const user = await auth.getUserByEmail(email).catch((err) => {
  if (err?.code === 'auth/user-not-found') return null;
  console.error(`Could not look up ${email} in ${projectId}:`);
  console.error(err?.code ? `  ${err.code}: ${err.message}` : `  ${err}`);
  process.exit(1);
});

if (!user) {
  console.error(
    `No account for ${email} in project ${projectId}.\n` +
      `Sign up through the app first, then re-run this.`,
  );
  process.exit(1);
}

await auth.setCustomUserClaims(user.uid, { role: 'admin' });

// ── /users mirror ──
const now = new Date().toISOString();
const fields = {
  role: { stringValue: 'admin' },
  email: { stringValue: user.email ?? email },
  displayName: user.displayName ? { stringValue: user.displayName } : { nullValue: null },
  photoURL: user.photoURL ? { stringValue: user.photoURL } : { nullValue: null },
  clientId: { nullValue: null },
  active: { booleanValue: true },
  updatedAt: { timestampValue: now },
};

if (useEmulator) {
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  await getFirestore()
    .doc(`users/${user.uid}`)
    .set(
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
} else {
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${f}`)
    .join('&');
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)` +
    `/documents/users/${user.uid}?${mask}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    console.error(`Claims were set, but the /users mirror write failed: ${res.status}`);
    console.error(await res.text());
    console.error('The role is still active — the mirror is display-only.');
    process.exit(1);
  }
}

// Their current ID token still says whatever it said before, for up to an hour.
await auth.revokeRefreshTokens(user.uid);

console.log(`${email} (${user.uid}) is now an admin in ${projectId}.`);
console.log('Sign out and back in — the old ID token still carries the previous role.');
