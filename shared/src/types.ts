/**
 * FirmOffice — canonical data model.
 *
 * This file is the ONLY definition of the Firestore shapes. Both `web/` (Firebase
 * Web SDK) and `functions/` (Firebase Admin SDK) import from here, so a schema change
 * cannot silently desync the reader from the writer.
 */

/**
 * Structurally compatible with both `firebase/firestore` Timestamp and
 * `firebase-admin/firestore` Timestamp, so the same interfaces work on both sides
 * without either SDK leaking into this package.
 */
export interface Timestampish {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Users & roles
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'client' | 'accountant' | 'admin';

/**
 * Custom claims on the Firebase ID token. This — not the /users document — is the
 * authorization source of truth read by the security rules.
 *
 * Hard limit: the entire claims payload must stay under 1000 bytes, which is why
 * accountants get blanket access rather than an `assignedClientIds` array.
 */
export interface AuthClaims {
  role: Role;
  /** Present only when role === 'client'. */
  clientId?: string;
}

/** /users/{uid} — a readable mirror of the claims, for UI display. Server-written. */
export interface UserDoc {
  role: Role;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  /** Set when role === 'client'; links to /clients/{clientId}. */
  clientId: string | null;
  /**
   * False for a self-registered client who has not been linked to a /clients record
   * yet. Display only — the security boundary is the absence of a clientId CLAIM,
   * not this field, which rules never read.
   */
  active: boolean;
  createdAt: Timestampish;
  updatedAt: Timestampish | null;
  lastLoginAt: Timestampish | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clients
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientCounters {
  pending: number;
  in_progress: number;
  processed: number;
}

/** /clients/{clientId} */
export interface ClientDoc {
  name: string;
  legalName: string | null;
  taxId: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  /**
   * Unique per-client ingest token, e.g. 'acme7k2' → docs+acme7k2@firm.com.
   * The highest-confidence rung of the Gmail mapping ladder — give this to the
   * client on their engagement letter and most mail self-files.
   */
  ingestAlias: string;
  status: 'active' | 'archived';
  assignedAccountantIds: string[];
  counters: ClientCounters;
  createdAt: Timestampish;
  updatedAt: Timestampish;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client identifier mapping table
// ─────────────────────────────────────────────────────────────────────────────

export type IdentifierType = 'alias' | 'email' | 'domain' | 'phone' | 'subjectCode';

/**
 * /clientIdentifiers/{key} where key === `${type}:${normalizedValue}`.
 *
 * Using the normalized identifier AS the document ID makes resolution a single
 * getDoc() — no query, no composite index — and Firestore's create-fails-if-exists
 * gives atomic uniqueness, so two clients can never claim the same address.
 */
export interface ClientIdentifierDoc {
  type: IdentifierType;
  value: string;
  clientId: string;
  /** Default confidence contributed by a match on this identifier. */
  confidence: number;
  verified: boolean;
  source: 'manual' | 'auto' | 'seed';
  createdBy: string | null;
  createdAt: Timestampish;
  lastMatchedAt: Timestampish | null;
  matchCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────

export type Channel = 'web' | 'gmail' | 'whatsapp';

/**
 * Machine state. Deliberately SEPARATE from workflowStatus: conflating them means a
 * document whose OCR fails either vanishes from the accountant's Pending count or
 * shows them a raw error string.
 */
export type PipelineStatus =
  | 'uploading'
  | 'received'
  | 'ocr_queued'
  | 'ocr_running'
  | 'ocr_done'
  | 'ocr_failed'
  | 'skipped_ocr'
  | 'rejected';

/** Human state. This — and only this — is what the metrics bar counts. */
export type WorkflowStatus = 'pending' | 'in_progress' | 'processed';

export type ClientMatchMethod =
  | 'alias'
  | 'email'
  | 'domain'
  | 'subjectCode'
  | 'forwarded'
  | 'replyTo'
  | 'phone'
  | 'manual'
  | 'portal'
  /** The ladder ran and every rung missed. Recorded, not left null — see below. */
  | 'none';

export interface ClientMatch {
  method: ClientMatchMethod;
  confidence: number;
  /** The identifier document that matched, e.g. `email:john@acme.com`. */
  matchedIdentifier?: string | null;
  /**
   * A candidate the ladder found but did NOT auto-file, because its confidence fell
   * below AUTO_ASSIGN_MIN_CONFIDENCE — a bare domain match, a reply-to, or anything
   * whose sender authentication failed.
   *
   * Kept separate from `clientId` on purpose: the document stays in the Unassigned
   * queue (so a human decides), but the UI can offer "file under Acme Ltd?" as one
   * click instead of making them search. Writing a guess into clientId instead would
   * silently file a possibly-forged invoice into a real client's folder.
   */
  suggestedClientId?: string | null;
  suggestedClientName?: string | null;
  /**
   * True when a rung matched but sender authentication (DKIM/SPF) explicitly failed,
   * so the confidence was cut. Surfaced in the UI — "this claims to be from X" is a
   * materially different statement from "this is from X".
   */
  authDowngraded?: boolean;
  /** Set when an accountant resolved it by hand from the Unassigned queue. */
  resolvedBy?: string;
  resolvedAt: Timestampish;
}

export interface FileMeta {
  originalName: string;
  storagePath: string;
  /** Sniffed server-side from magic bytes — never the client-supplied MIME type. */
  contentType: string;
  sizeBytes: number;
  /**
   * Empty string until the ingest trigger has read the bytes and hashed them. The
   * uploader never supplies this: a client-computed hash could be forged, and the
   * duplicate check has to be trustworthy to be worth running.
   */
  sha256: string;
  pageCount?: number;
}

export type OcrMethod =
  | 'documentTextDetection'
  | 'batchAnnotateFiles'
  | 'asyncBatchAnnotateFiles'
  | 'pdfTextLayer'
  | 'none';

export interface OcrResult {
  engine: 'vision-v1' | 'pdf-parse';
  method: OcrMethod;
  /** Inline only when under OCR_INLINE_TEXT_LIMIT_BYTES; otherwise null. */
  fullText: string | null;
  /** Overflow target when the text is too large for a 1 MiB Firestore document. */
  textStoragePath: string | null;
  /** First ~2000 chars. ALWAYS present, so list views never touch Storage. */
  preview: string;
  pageCount: number;
  avgConfidence: number | null;
  lowConfidence: boolean;
  languageCodes: string[];
  completedAt: Timestampish;
  durationMs: number;
  /**
   * True when the text produced more tokens than MAX_SEARCH_TOKENS, so `searchTokens`
   * covers only part of this document. Surfaced rather than hidden — otherwise partial
   * search coverage looks identical to complete coverage.
   */
  tokensTruncated: boolean;
}

/** Structured field extraction. Populated in M6; empty object before then. */
export interface ExtractedFields {
  documentType?: string;
  invoiceNumber?: string;
  issueDate?: string;
  totalAmount?: number;
  currency?: string;
  vatAmount?: number;
  vendorName?: string;
  vendorTaxId?: string;
}

export type ErrorCode =
  | 'UNSUPPORTED_TYPE'
  | 'FILE_TOO_LARGE'
  | 'FILE_EMPTY'
  | 'FILE_CORRUPT'
  | 'PDF_ENCRYPTED'
  | 'PDF_TOO_MANY_PAGES'
  | 'CONVERSION_FAILED'
  | 'VISION_QUOTA'
  | 'VISION_ERROR'
  | 'DOWNLOAD_FAILED'
  | 'UPLOAD_TIMEOUT'
  | 'INTERNAL';

export interface DocError {
  code: ErrorCode;
  message: string;
  /** Which stage produced it: 'ingest' | 'validate' | 'ocr' | 'thumbnail'. */
  stage: string;
  attempts: number;
  lastAttemptAt: Timestampish;
}

export interface GmailSource {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  attachmentId: string;
  /**
   * The `+tag` the message was addressed to, when it arrived at a per-client drop
   * address. Null for mail sent to the plain ingest mailbox.
   */
  toAlias: string | null;
  /** DKIM/SPF results from the Authentication-Results header. A `From:` header is
   *  trivially spoofable, so a failure downgrades confidence to Unassigned. */
  dkimPass: boolean | null;
  spfPass: boolean | null;
}

export interface WhatsAppSource {
  waMessageId: string;
  waId: string;
  phoneNumberId: string;
  caption: string | null;
}

export interface WebSource {
  userAgent: string | null;
}

export type DocumentSource = GmailSource | WhatsAppSource | WebSource;

/** /documents/{docId} — the core collection. */
export interface DocumentDoc {
  // ── ownership ──
  clientId: string | null;
  /**
   * OPTIONAL, and the `?` is load-bearing.
   *
   * A Client Portal upload is created by the browser under a security rule that
   * allowlists an exact set of keys, and `clientMatch` is not one of them — a client
   * must not be able to assert how they were matched. So the field is genuinely
   * ABSENT on portal documents until the ingest trigger fills it in, and on every
   * document created before that trigger did so.
   *
   * Declaring it `ClientMatch | null` was a lie the compiler believed: a `!== null`
   * guard type-checked, passed for `undefined`, and crashed the whole Inbox on the
   * first dereference. Optional is the honest type, and it makes tsc reject exactly
   * that mistake.
   */
  clientMatch?: ClientMatch | null;
  /** Denormalized so the inbox list renders without an N+1 join on /clients. */
  clientNameCache: string | null;
  uploadedByUid: string | null;

  // ── provenance ──
  channel: Channel;
  source: DocumentSource;

  // ── file ──
  file: FileMeta;
  thumbnailPath: string | null;
  /** Points at the first-seen doc when this is a re-send of identical bytes. */
  duplicateOf: string | null;

  // ── the two status axes ──
  pipelineStatus: PipelineStatus;
  workflowStatus: WorkflowStatus;
  assignedAccountantUid: string | null;
  /**
   * Who last moved workflowStatus. Written by the client, but the security rules
   * require it to equal the caller's own uid, so it cannot be forged — which is what
   * makes it usable as the audit trail's actor.
   *
   * Without this the trail records every status change as `system`, and "who marked
   * this processed" — a question a CPA firm eventually has to answer — is unanswerable.
   */
  statusActorUid: string | null;

  // ── results ──
  ocr: OcrResult | null;
  /**
   * Deduplicated word tokens from the OCR text, queried with `array-contains`.
   *
   * Firestore has no full-text search; this is the chosen substitute (OPEN ITEM #3).
   * Whole words only — no prefix or fuzzy matching. Capped, because Firestore writes
   * one index entry per array element.
   */
  searchTokens: string[];
  extracted: ExtractedFields;
  error: DocError | null;

  // ── time ──
  /** When the CLIENT sent it (email Date / WhatsApp timestamp). Sort the inbox by
   *  this — after a poller outage recovers, createdAt ordering looks scrambled. */
  receivedAt: Timestampish;
  /** When WE ingested it. */
  createdAt: Timestampish;
  updatedAt: Timestampish;
  deletedAt: Timestampish | null;
}

/** /documents/{docId}/pages/{pageNumber} */
export interface PageDoc {
  pageNumber: number;
  text: string;
  confidence: number | null;
  width: number | null;
  height: number | null;
}

export type DocEventType =
  | 'ingested'
  | 'ocr_started'
  | 'ocr_completed'
  | 'ocr_failed'
  | 'status_changed'
  | 'reassigned'
  | 'viewed'
  | 'deleted';

/** /documents/{docId}/events/{eventId} — append-only audit trail. */
export interface DocEvent {
  type: DocEventType;
  actor: { type: 'system' | 'user'; uid?: string };
  from?: string | null;
  to?: string | null;
  meta?: Record<string, unknown>;
  at: Timestampish;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * /metrics/global — backs the real-time status badges via ONE onSnapshot listener.
 *
 * Maintained by an onDocumentWritten trigger applying FieldValue.increment(±1).
 * Aggregation queries (getCountFromServer) were rejected because they cannot be
 * subscribed to, and the badges must be live.
 */
export interface MetricsDoc {
  counts: {
    pending: number;
    in_progress: number;
    processed: number;
    unassigned: number;
    ocr_failed: number;
  };
  byChannel: Record<Channel, number>;
  updatedAt: Timestampish;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operational collections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * /ingestState/gmail — the poller's own health record.
 *
 * Deliberately NOT a cursor. The poller re-queries a fixed lookback window every run
 * and relies on the idempotency ledger to skip what it has already seen, so an outage
 * shorter than the window self-heals with no state to reconcile. This document exists
 * to answer "is ingestion actually alive?", which is the failure nobody notices:
 * a poller that silently stopped looks exactly like a quiet week.
 */
export interface IngestStateDoc {
  /**
   * The address the stored refresh token actually belongs to, read back from Gmail
   * on each run rather than configured.
   *
   * The dashboard needs it to show each client their drop address
   * (`mailbox+{ingestAlias}@…`), and a value that drifted from the account the token
   * was minted for would print addresses that silently go nowhere.
   */
  mailbox: string | null;
  lastPollAt: Timestampish | null;
  /** Last run that completed without throwing — the field the silent-failure alarm reads. */
  lastSuccessAt: Timestampish | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Cumulative, for a sanity check against the documents collection. */
  totalIngested: number;
}

/**
 * /processedMessages/{provider}:{externalId} — the idempotency ledger.
 *
 * Written in the SAME batch as the document it records. If the document create fails
 * the ledger entry rolls back with it, so a retry re-ingests rather than skipping a
 * message that was never actually stored. TTL 90 days, set in the console.
 */
export interface ProcessedMessageDoc {
  docId: string;
  channel: Channel;
  processedAt: Timestampish;
  /** TTL policy field. Firestore deletes the row once this passes. */
  expiresAt: Timestampish;
}

/** /failedIngestions/{id} — dead letter. Nothing is allowed to vanish silently. */
export interface FailedIngestionDoc {
  channel: Channel;
  externalId: string;
  reason: string;
  payload: Record<string, unknown>;
  attempts: number;
  at: Timestampish;
}

// ─────────────────────────────────────────────────────────────────────────────
// Callable function contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface GetDocumentUrlRequest {
  docId: string;
}
export interface GetDocumentUrlResponse {
  url: string;
  contentType: string;
  expiresAt: number;
}

export interface SetUserRoleRequest {
  uid: string;
  role: Role;
  /** Required when role === 'client'; ignored otherwise. */
  clientId?: string;
}

export interface SetUserRoleResponse {
  uid: string;
  role: Role;
  clientId: string | null;
  /**
   * The target's refresh tokens were revoked, so their next request forces a fresh
   * ID token. Without this an old token keeps its previous role for up to an hour.
   */
  tokensRevoked: boolean;
}

/**
 * Self-registration for a client who signed themselves up.
 *
 * Takes no payload — it reads `request.auth` — and is idempotent: a user who already
 * holds a role gets it echoed back rather than reset, so the SPA can call it blindly
 * whenever it sees a token with no role claim.
 *
 * The result is deliberately UNLINKED: `role: 'client'` with `clientId: null`. A
 * stranger who signs up can therefore reach no client's documents — the rules require
 * a non-empty clientId claim — until an accountant links them via setUserRole.
 */
export interface RegisterClientResponse {
  role: Role;
  clientId: string | null;
  active: boolean;
  /** False when the caller already had a role and nothing was written. */
  created: boolean;
}

export interface CreateClientRequest {
  name: string;
  legalName?: string;
  taxId?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
}

export interface CreateClientResponse {
  clientId: string;
  /** Generated server-side; the local part of docs+{alias}@firm.com. */
  ingestAlias: string;
  /** True when primaryContactEmail was also seeded into the mapping table. */
  emailIdentifierCreated: boolean;
}

export interface RetryOcrRequest {
  docId: string;
}

export interface RetryOcrResponse {
  docId: string;
  /** False when the document was already succeeding and nothing needed re-running. */
  requeued: boolean;
  reason?: string;
}

/**
 * Records a sender→client mapping learned from an accountant's manual assignment —
 * the "always file mail from john@acme.com under Acme Ltd" checkbox.
 *
 * This is what stops the Unassigned queue being a permanent tax: every hand-filed
 * document can teach the ladder one identifier, so manual work trends to zero as the
 * firm's real-world identifier set gets captured.
 */
export interface LinkIdentifierRequest {
  type: IdentifierType;
  /** Raw value; normalized server-side so the caller cannot desync the key format. */
  value: string;
  clientId: string;
  /** Also re-file every earlier Unassigned document this identifier would have matched. */
  backfill?: boolean;
}

export interface LinkIdentifierResponse {
  key: string;
  clientId: string;
  /** False when the identifier already existed and was left pointing where it was. */
  created: boolean;
  /** Set when the identifier is already claimed by a DIFFERENT client. */
  conflictWithClientId?: string;
  /** How many previously-unassigned documents were re-filed. */
  backfilled: number;
}

export interface PollGmailResponse {
  ok: boolean;
  messagesSeen: number;
  attachmentsIngested: number;
  skippedDuplicates: number;
  skippedInline: number;
  errors: string[];
}

export interface HealthCheckResponse {
  ok: boolean;
  service: string;
  version: string;
  emulated: boolean;
  serverTime: string;
}
