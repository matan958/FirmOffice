import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { FUNCTIONS_REGION } from './shared.js';
import { isEmulated } from './lib/firebase.js';
import type { HealthCheckResponse } from './shared.js';

/**
 * Global defaults for every function in this codebase.
 *
 * `maxInstances` is a deliberate cost guard, not a performance tuning knob: a bulk
 * upload or a misconfigured poller must not be able to fan out into thousands of
 * concurrent Vision calls before anyone notices the bill.
 */
setGlobalOptions({
  region: FUNCTIONS_REGION,
  maxInstances: 10,
  memory: '512MiB',
  timeoutSeconds: 120,
});

const VERSION = '0.1.0';

/**
 * M0 connectivity probe. Confirms the SPA can reach callable functions, that region
 * and CORS are wired correctly, and that auth context is being propagated.
 */
export const healthCheck = onCall<void, Promise<HealthCheckResponse>>(async (request) => {
  return {
    ok: true,
    service: 'firmoffice-functions',
    version: VERSION,
    emulated: isEmulated,
    serverTime: new Date().toISOString(),
    // Echoed back so the health page can prove custom claims are landing.
    ...(request.auth
      ? { uid: request.auth.uid, role: (request.auth.token['role'] as string) ?? null }
      : {}),
  } as HealthCheckResponse;
});

/** Unauthenticated liveness endpoint for uptime checks. */
export const ping = onRequest({ cors: true }, (_req, res) => {
  res.status(200).json({ ok: true, version: VERSION, serverTime: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// M1 — Auth & RBAC
// ─────────────────────────────────────────────────────────────────────────────

export { setUserRole } from './admin/setUserRole.js';
export { registerClient } from './auth/registerClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// M2 — Clients & ingestion
// ─────────────────────────────────────────────────────────────────────────────

export { createClient } from './admin/createClient.js';
export { onDocumentUploaded } from './ingest/onUpload.js';

// ─────────────────────────────────────────────────────────────────────────────
// Milestone map — each export below arrives with its milestone.
//
//   M2  ingest/web.ts               onObjectFinalized('incoming/**')
//   M2  core/ingestDocument.ts      the one channel-agnostic entry point
//   M2  ocr/tasks.ts                onTaskDispatched — Vision, with retry + backoff
//   M2  metrics/counters.ts         onDocumentWritten — increments /metrics/global
//   M3  admin/getDocumentUrl.ts     callable, 15-min V4 signed URL + `viewed` audit
//   M3  ocr/retry.ts                callable, re-enqueues a failed OCR task
//   M4  ingest/gmail.ts             onSchedule poller + mapping/resolveClient.ts
//   M5  ingest/whatsapp.ts          onRequest webhook, 200-then-async
//   M6  jobs/janitor.ts             onSchedule — unsticks 'uploading' / 'ocr_running'
//   M6  jobs/healthcheck.ts         onSchedule — alerts on silent ingestion failure
// ─────────────────────────────────────────────────────────────────────────────
