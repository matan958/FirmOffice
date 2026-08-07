#!/usr/bin/env node
/**
 * Applies cors.json to the project's default Storage bucket.
 *
 * Why this matters: react-pdf fetches the signed preview URL cross-origin and asks
 * for byte ranges. Without CORS on the bucket the request is blocked by the browser
 * and the viewer fails with an error that points nowhere near the real cause. This
 * is the classic multi-hour debugging trap on this stack — do it in M0.
 *
 * Requires Application Default Credentials:
 *   gcloud auth application-default login
 * If gcloud isn't installed, use the Cloud Shell one-liner in the README instead.
 *
 *   node scripts/set-cors.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Storage } from '@google-cloud/storage';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = resolve(HERE, '..');

const { projects } = JSON.parse(readFileSync(resolve(root, '.firebaserc'), 'utf8'));
const projectId = process.env.GCLOUD_PROJECT ?? projects?.default;

if (!projectId || projectId.startsWith('REPLACE_WITH')) {
  console.error('Set your project ID in .firebaserc first (or export GCLOUD_PROJECT).');
  process.exit(1);
}

const cors = JSON.parse(readFileSync(resolve(root, 'cors.json'), 'utf8'));

const stillPlaceholder = JSON.stringify(cors).includes('REPLACE_WITH');
if (stillPlaceholder) {
  console.error('cors.json still contains REPLACE_WITH_… — put your real hosting origins in it.');
  process.exit(1);
}

const bucketName = process.env.STORAGE_BUCKET ?? `${projectId}.firebasestorage.app`;
const storage = new Storage({ projectId });

await storage.bucket(bucketName).setCorsConfiguration(cors);
console.log(`CORS applied to gs://${bucketName}`);
console.log(JSON.stringify(cors, null, 2));
