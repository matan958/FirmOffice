/** FirmOffice — shared constants. Values that MUST agree between client and server. */

// ─── Firestore collection paths ──────────────────────────────────────────────

export const COLLECTIONS = {
  users: 'users',
  clients: 'clients',
  clientIdentifiers: 'clientIdentifiers',
  documents: 'documents',
  metrics: 'metrics',
  ingestState: 'ingestState',
  processedMessages: 'processedMessages',
  failedIngestions: 'failedIngestions',
} as const;

export const SUBCOLLECTIONS = {
  pages: 'pages',
  events: 'events',
} as const;

/** The single document backing the real-time status badges. */
export const METRICS_DOC_ID = 'global';

// ─── Storage prefixes ────────────────────────────────────────────────────────

export const STORAGE_PREFIX = {
  incoming: 'incoming',
  thumbnails: 'thumbnails',
  ocrOutput: 'ocr-output',
  ocrText: 'ocr-text',
  quarantine: 'quarantine',
} as const;

/** Bucket used for documents that arrived without a resolvable client. */
export const UNASSIGNED_CLIENT_PREFIX = '_unassigned';

export function incomingPath(clientId: string | null, docId: string, fileName: string): string {
  return `${STORAGE_PREFIX.incoming}/${clientId ?? UNASSIGNED_CLIENT_PREFIX}/${docId}/${fileName}`;
}

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Overall upload ceiling, enforced in storage.rules AND re-checked server-side. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Cloud Vision's own limit for a single image. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Above 5 pages Vision cannot answer synchronously — must use the async LRO path. */
export const VISION_SYNC_PAGE_LIMIT = 5;

/** Vision's hard cap on pages in one file. */
export const VISION_MAX_PAGES = 2000;

/**
 * A Firestore document is capped at 1 MiB and the write simply fails past it.
 * OCR text above this threshold is spilled to Storage instead.
 */
export const OCR_INLINE_TEXT_LIMIT_BYTES = 200 * 1024;

/** Always stored inline, so list views and search snippets never touch Storage. */
export const OCR_PREVIEW_CHARS = 2000;

/** Below this average Vision confidence, flag the document for a human look. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Signed preview URLs are deliberately short-lived. */
export const SIGNED_URL_TTL_MINUTES = 15;

// ─── File type allowlist ─────────────────────────────────────────────────────

/** Types Cloud Vision can OCR directly. */
export const OCR_SUPPORTED_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'image/gif',
] as const;

/**
 * Accepted and stored, but OCR is skipped (pipelineStatus: 'skipped_ocr').
 * An .xlsx bank statement is still a document the firm needs — never reject
 * something a client legitimately sent just because we can't read it.
 */
export const STORE_ONLY_MIME = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/**
 * Vision does NOT support HEIC/HEIF, and iPhone photos sent by mail or WhatsApp
 * frequently are. OPEN ITEM #2: convert on ingest, or reject with a clear message.
 * Leaving it unhandled looks like "ingestion is broken".
 */
export const NEEDS_CONVERSION_MIME = ['image/heic', 'image/heif'] as const;

// ─── Client mapping ──────────────────────────────────────────────────────────

/**
 * Never allow a `domain:` identifier for these — one such row would map every
 * Gmail user on earth to a single client.
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com', 'mail.com',
  'walla.com', 'walla.co.il', 'nana10.co.il', '013.net', 'bezeqint.net',
]);

/** Default confidence per mapping-ladder rung. */
export const MATCH_CONFIDENCE: Record<string, number> = {
  alias: 1.0,
  manual: 1.0,
  portal: 1.0,
  email: 0.95,
  subjectCode: 0.85,
  phone: 0.9,
  forwarded: 0.7,
  domain: 0.6,
  replyTo: 0.5,
};

/** Below this, route to the Unassigned queue instead of auto-filing. */
export const AUTO_ASSIGN_MIN_CONFIDENCE = 0.6;

export function identifierKey(type: string, value: string): string {
  return `${type}:${value}`;
}

// ─── Operational ─────────────────────────────────────────────────────────────

/** Region for all Cloud Functions. Keep the bucket in the same region. */
export const FUNCTIONS_REGION = 'us-central1';

export const OCR_TASK_QUEUE = 'ocr-queue';

/** Janitor thresholds — anything past these is stuck and gets re-enqueued or failed. */
export const STUCK_UPLOADING_MINUTES = 15;
export const STUCK_OCR_MINUTES = 30;

/** Gmail poller lookback. Any outage shorter than this self-heals on the next run. */
export const GMAIL_LOOKBACK_DAYS = 2;
export const GMAIL_PROCESSED_LABEL = 'Processed/FirmOffice';

/** Window for treating identical bytes from the same client as a re-send. */
export const DUPLICATE_WINDOW_DAYS = 90;
