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
  /**
   * HEIC converted to JPEG on ingest. A separate prefix, not an in-place overwrite:
   * writing back into incoming/ would re-fire the ingest trigger on its own output.
   * The original HEIC stays where it landed, so provenance is not destroyed.
   */
  converted: 'converted',
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

/**
 * Storage object names disallow `#`, `[`, `]`, `*` and `?`, and control characters or
 * a leading dot make a path that is awkward to handle everywhere downstream. The
 * ORIGINAL name is preserved in file.originalName — this only sanitizes the path.
 *
 * Shared rather than browser-side: a mail attachment's filename comes from whoever
 * sent it and gets far less scrutiny than a file a client picked in a file dialog.
 * `..` is collapsed too — a Storage path is not a filesystem path, but a name that
 * looks like traversal ends up in logs, ZIP exports and download headers.
 */
export function safeObjectName(name: string): string {
  // Drop C0 control characters and DEL. Done with codepoint arithmetic rather than
  // a regex range so that no literal control byte ever sits in this source file —
  // they are invisible in most editors and do not survive a careless copy-paste.
  const printable = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');

  const cleaned = printable
    .replace(/[#[\]*?/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  return cleaned.slice(0, 200) || 'file';
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

// ─── Search (OPEN ITEM #3, decided: denormalized token array) ────────────────

/**
 * Firestore has no full-text search, so OCR text is reduced to a deduplicated token
 * array queried with `array-contains`. Whole words only — no prefix or fuzzy matching.
 *
 * The cap matters: Firestore writes one index entry per array element, against a limit
 * of roughly 40,000 index entries per document. A dense 50-page scan would otherwise
 * produce a token array that inflates both write cost and index size.
 */
export const MAX_SEARCH_TOKENS = 400;

/** Single characters are almost pure noise and consume cap that a real term needs. */
export const MIN_TOKEN_LENGTH = 2;

/**
 * Dropped before the cap is applied, so common words cannot crowd out the distinctive
 * terms people actually search for. Deliberately short: over-filtering costs recall,
 * and an accountant searching a vendor name called "The Mill" would not thank us.
 */
export const SEARCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'his', 'has', 'had', 'were', 'they', 'from', 'this', 'that', 'with',
  'have', 'been', 'will', 'your', 'their', 'which', 'would', 'there', 'about',
  // Hebrew function words — documents from Israeli clients are expected.
  'של', 'את', 'עם', 'על', 'לא', 'כל', 'זה', 'הוא', 'היא', 'אני', 'אנחנו',
]);

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

/**
 * Canonical form of an email address for use as an identifier key.
 *
 * Lowercase, strip any `+tag`, and strip dots ONLY for Gmail — Gmail treats
 * `j.smith@` and `jsmith@` as the same mailbox, but most other providers do not, so
 * stripping dots everywhere would collapse genuinely different people onto one client.
 *
 * Note this is for the exact-address rung. The PUBLIC_EMAIL_DOMAINS blocklist applies
 * to `domain:` identifiers only — an exact `email:` match on a gmail.com address is
 * perfectly legitimate.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replaceAll('.', '');
  }
  return `${local}@${domain}`;
}

/**
 * The address to print on a client's engagement letter.
 *
 * `firmoffice.docs@gmail.com` + `acme7k2` → `firmoffice.docs+acme7k2@gmail.com`.
 *
 * The mailbox is not hardcoded because it is read back from Gmail at poll time; a
 * configured value that drifted from the account the refresh token belongs to would
 * have the dashboard printing addresses that silently go nowhere. Returns null when
 * the poller has never run, so the UI can say "not connected yet" instead of showing
 * a half-built address that looks real.
 */
export function dropAddress(mailbox: string | null, ingestAlias: string): string | null {
  if (!mailbox) return null;
  const at = mailbox.lastIndexOf('@');
  if (at <= 0) return null;
  return `${mailbox.slice(0, at)}+${ingestAlias}${mailbox.slice(at)}`;
}

/** Local part of the per-client drop address, e.g. 'acme7k2' → docs+acme7k2@firm.com. */
export function ingestAliasFrom(name: string, suffix: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return `${slug || 'client'}${suffix}`;
}

// ─── Operational ─────────────────────────────────────────────────────────────

/**
 * Region for all Cloud Functions.
 *
 * MUST equal the Storage bucket's region. Gen 2 storage triggers are delivered by
 * Eventarc, which refuses to register a cross-region subscription — the deploy fails
 * outright with "a function in region X cannot listen to a bucket in region Y". This
 * is a hard constraint, not a latency preference.
 *
 * us-east1 because the project's default bucket landed there; moving the function is
 * a one-line change, moving the default bucket is not. Firestore is `nam5`, a US
 * multi-region, which any US function region can reach.
 */
export const FUNCTIONS_REGION = 'us-east1';

export const OCR_TASK_QUEUE = 'ocr-queue';

/** Janitor thresholds — anything past these is stuck and gets re-enqueued or failed. */
export const STUCK_UPLOADING_MINUTES = 15;
export const STUCK_OCR_MINUTES = 30;

// ─── Gmail ingestion ─────────────────────────────────────────────────────────

/**
 * Poller lookback. The query is `newer_than:{N}d -label:{processed}`, so any outage
 * shorter than this self-heals on the next successful run with no cursor to reconcile
 * and no gap detection. Past it, a manual backfill is needed — which is the trade for
 * having no state that can silently drift.
 */
export const GMAIL_LOOKBACK_DAYS = 2;

/**
 * Applied to a message once every attachment on it is safely stored.
 *
 * Both label names are free of spaces on purpose. They are excluded from the poller's
 * query via Gmail's `-label:` search operator, whose quoting rules around spaces and
 * nesting are inconsistent enough that a mis-parsed name would silently match nothing
 * — leaving the exclusion inert and the poller re-reading its whole window forever.
 */
export const GMAIL_PROCESSED_LABEL = 'FirmOffice/Processed';

/** Applied instead when a message carried something a human needs to look at. */
export const GMAIL_ATTENTION_LABEL = 'FirmOffice/Attention';

/**
 * Cap per run. The lookback window already bounds this, but a first run against a
 * busy mailbox — or a mailbox where labelling silently fails — must not fan out into
 * hundreds of Vision calls before anyone sees the bill.
 */
export const GMAIL_MAX_MESSAGES_PER_RUN = 25;

/**
 * Inline images below this size are treated as email-signature furniture (logos,
 * social icons, tracking pixels) rather than documents.
 *
 * Size alone is not the test — a `Content-ID` and a `Content-Disposition: inline`
 * are the real signals, checked in gmail/parts.ts. This is the backstop for senders
 * whose client omits both. Get this wrong and every message from a corporate sender
 * spawns three junk documents that an accountant has to clear by hand.
 */
export const INLINE_IMAGE_MAX_BYTES = 100 * 1024;

/**
 * Attachment types Gmail delivers that we deliberately reject with a notice rather
 * than store: an archive or a forwarded .eml is a CONTAINER, and storing it means the
 * firm has a document it cannot read, OCR, or search. Unpacking them is M6 work.
 */
export const CONTAINER_MIME = [
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/gzip',
  'message/rfc822',
] as const;

/** `[ACME-123]` anywhere in a subject line. Case-insensitive; captures the code. */
export const SUBJECT_CODE_RE = /\[([A-Za-z0-9][A-Za-z0-9_-]{1,31})\]/;

/** Ledger key. Attachment index, not attachmentId — see gmail/parts.ts. */
export function processedMessageKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

/** Window for treating identical bytes from the same client as a re-send. */
export const DUPLICATE_WINDOW_DAYS = 90;
