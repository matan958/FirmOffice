/** FirmOffice — shared constants. Values that MUST agree between client and server. */

// Type-only, so this stays a one-way dependency with no runtime import cycle.
import type { DocDirection } from './types.js';

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

/**
 * Language hints passed to Vision on every request.
 *
 * DOCUMENT_TEXT_DETECTION auto-detects script, but detection is a guess made from the
 * image, and on a creased thermal receipt it is a poor one. Hebrew is right-to-left
 * with a small alphabet that Vision will otherwise sometimes read as Arabic or as
 * Latin lookalikes, and the failure is not an error — it is plausible-looking text
 * that is wrong, which is far worse for an accountant than no text at all.
 *
 * Hints are a bias, not a filter: a document in a language not listed here is still
 * read. Keep the list SHORT for that reason — Google's guidance is that a long hint
 * list degrades accuracy rather than covering more ground.
 */
export const VISION_LANGUAGE_HINTS = ['he', 'en'] as const;

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

// ─── Structured field extraction ─────────────────────────────────────────────

export type ExtractedFieldKey =
  | 'documentType'
  | 'invoiceNumber'
  | 'issueDate'
  | 'vendorName'
  | 'vendorTaxId'
  | 'netAmount'
  | 'vatAmount'
  | 'totalAmount'
  // Read from every document, never given a row of its own — see COUNTERPARTY_FIELDS.
  | 'recipientName'
  | 'recipientTaxId';

export interface ExtractedFieldSpec {
  key: ExtractedFieldKey;
  /** Shown verbatim in the UI. Hebrew, because the documents and the readers are. */
  label: string;
  kind: 'text' | 'date' | 'money' | 'id';
  /** Guidance handed to the model for this one field. */
  hint: string;
}

/**
 * THE field list. This array is the single source of truth for both what the model is
 * asked to find and what the panel renders, in this order.
 *
 * That coupling is the point. "Only the fields I need, in the order I say" is a
 * configuration question, not a code question — reordering these lines reorders the
 * panel, and deleting one stops it being extracted at all rather than leaving the
 * model paying to find something nobody reads.
 *
 * Labels are Hebrew and stay Hebrew even though the surrounding UI is English: they
 * are the exact wording that appears on an Israeli tax document, and an accountant
 * matching the panel against the scan beside it should be comparing like with like.
 */
export const EXTRACTION_FIELDS: readonly ExtractedFieldSpec[] = [
  {
    key: 'documentType',
    label: 'סוג מסמך',
    kind: 'text',
    hint: 'The document\'s own Hebrew wording — חשבונית מס, קבלה, חשבונית מס-קבלה, תעודת משלוח. Copy it as printed; do not translate or normalize it.',
  },
  {
    key: 'invoiceNumber',
    label: 'מספר חשבונית',
    kind: 'text',
    hint: 'The document number (מספר / מס\' / אסמכתא). Keep leading zeros and any hyphens exactly as printed — it is an identifier, not a number.',
  },
  {
    key: 'issueDate',
    label: 'תאריך',
    kind: 'date',
    hint: 'Date of issue, as ISO yyyy-mm-dd. Israeli dates are DAY-FIRST: 12/03/2026 is 12 March 2026, never 3 December.',
  },
  {
    key: 'vendorName',
    label: 'שם הספק',
    kind: 'text',
    hint: 'The business ISSUING the document, not the recipient. On a receipt this is the shop. Include the legal suffix (בע"מ) if printed.',
  },
  {
    key: 'vendorTaxId',
    label: 'ח.פ. / ע.מ.',
    kind: 'id',
    hint: 'The ISSUER\'s ח.פ. / ע.מ. / מספר עוסק מורשה. Digits only. If two tax numbers appear, take the one belonging to the issuer, never the customer.',
  },
  {
    key: 'netAmount',
    label: 'סכום לפני מע"מ',
    kind: 'money',
    hint: 'Amount BEFORE VAT (סה"כ לפני מע"מ / סכום חייב). Plain number, no currency symbol and no thousands separators.',
  },
  {
    key: 'vatAmount',
    label: 'מע"מ ששולם',
    kind: 'money',
    hint: 'The VAT amount itself (מע"מ), not the percentage rate. If the line reads "מע"מ 18%  37.98", this is 37.98.',
  },
  {
    key: 'totalAmount',
    label: 'סה"כ לתשלום',
    kind: 'money',
    hint: 'Final amount payable including VAT (סה"כ לתשלום / לתשלום / סה"כ כולל מע"מ).',
  },
];

/**
 * The other side of the document. Read from every document, never given a row.
 *
 * An invoice has two parties, and until now only one was read — the `vendorTaxId` hint
 * above still says to take the issuer's number "never the customer". That instruction
 * was throwing away the single fact that decides whether a document is income or an
 * expense, which is not a property of the document at all but of which side of it the
 * client sits on.
 *
 * These are kept OUT of EXTRACTION_FIELDS on purpose. The firm asked for eight rows in
 * a stated order and gets exactly eight; these two are evidence, not fields, and they
 * appear only underneath the direction as its justification. Same treatment as
 * `currency` below, done through the type system rather than by hand.
 */
export const COUNTERPARTY_FIELDS: readonly ExtractedFieldSpec[] = [
  {
    key: 'recipientName',
    label: 'שם הלקוח במסמך',
    kind: 'text',
    hint: 'The business the document is ADDRESSED TO (לכבוד / לקוח / שם הלקוח) — the buyer, not the issuer. Null on a retail receipt that names no customer.',
  },
  {
    key: 'recipientTaxId',
    label: 'ח.פ. הלקוח במסמך',
    kind: 'id',
    hint: 'The RECIPIENT\'s ח.פ. / ע.מ. / ת.ז. — the number printed beside לכבוד, never the issuer\'s. Digits only. Null if the document names no customer.',
  },
];

/** Everything the model is asked for. The panel renders only EXTRACTION_FIELDS. */
export const ALL_EXTRACTED_FIELDS: readonly ExtractedFieldSpec[] = [
  ...EXTRACTION_FIELDS,
  ...COUNTERPARTY_FIELDS,
];

/**
 * Extracted but never given a row of its own.
 *
 * The firm asked for eight fields and gets eight. Currency is still read, because
 * rendering ₪ against a dollar invoice would be a quiet, expensive lie — so it is
 * carried as the symbol on the amounts rather than as another line to read past.
 */
export const DEFAULT_CURRENCY = 'ILS';

export const CURRENCY_SYMBOL: Record<string, string> = {
  ILS: '₪',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

/**
 * Tolerance for the net + VAT = total check, in currency units.
 *
 * The check itself is rate-independent, which is why it is the one worth making:
 * Israeli VAT moved from 17% to 18% on 1 January 2025, so a hardcoded rate would
 * mis-flag every older document, but the addition has to hold whatever the rate.
 * Two agorot absorbs per-line rounding on a long receipt.
 */
export const AMOUNT_RECONCILE_TOLERANCE = 0.02;

/** Vertex AI, validated against the real endpoint on 2026-08-10. */
export const VERTEX_LOCATION = 'us-central1';
export const VERTEX_MODEL = 'gemini-2.5-flash';

// ─── Income vs expense ───────────────────────────────────────────────────────

/**
 * Israeli ח.פ. / ע.מ. / ת.ז. — nine digits.
 *
 * Shared rather than server-side because this is a JOIN KEY. It normalizes the number
 * on the client record AND the number read off the document, and the two are compared
 * for equality; two normalizers that disagreed by one character would make every
 * comparison miss silently, which looks exactly like "the classifier doesn't work".
 *
 * Eight digits are padded rather than rejected. A dropped leading zero is the ordinary
 * OCR failure on these, and `012345678` and `12345678` must not be two businesses.
 */
export function toTaxId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 9) return null;
  return digits.padStart(9, '0');
}

/** Suffixes that are legal furniture, not part of who the business is. */
const LEGAL_SUFFIX_RE = /בע"מ|בעמ|\bltd\b\.?|\blimited\b|\binc\b\.?|\bllc\b|\bcorp\b\.?|\bco\b\.?/gi;

/**
 * Canonical form of a business name, for the fallback rung of the direction ladder.
 *
 * Used for EXACT comparison after normalization, never fuzzy. Fuzzy matching on a tax
 * document is how a document ends up filed under the wrong company, and unlike a wrong
 * amount there is nothing about the result that looks wrong afterwards.
 *
 * The gershayim swap matters more than it looks: `בע״מ` printed with U+05F4 and `בע"מ`
 * typed with an ASCII quote are the same two letters to a reader and different strings
 * to a computer, and which one appears depends on whoever typed the client record.
 */
export function normalizeBusinessName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[׳״‘’“”]/g, '"')
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, ' ')
    // Punctuation last: the suffixes above contain quotes and dots of their own.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Document types that are not bookkeeping entries at all.
 *
 * `חשבון עסקה` is the one that earns this list. It looks like an invoice, carries
 * amounts and VAT, and is NOT a tax document — booking one is a real filing error, and
 * a system that offered only income-or-expense would force exactly that.
 */
export const NON_TAX_DOCUMENT_RE =
  /חשבון\s*עסקה|דרישת\s*תשלום|הצעת\s*מחיר|תעודת\s*משלוח|דף\s*חשבון|פירוט\s*עסקאות|אישור\s*ניכוי|הוראת\s*קבע|proforma|pro\s*forma|quotation|delivery\s*note|statement/i;

/**
 * Below this the direction is shown as needing a human look.
 *
 * Same role AUTO_ASSIGN_MIN_CONFIDENCE plays for client mapping: the ladder always
 * produces an answer, and this is the line between an answer to act on and an answer
 * to check. Set so that a name-only match (0.85) passes and an inference drawn from the
 * ABSENCE of a named customer (0.80) also passes — but only just, which is the point.
 */
export const DIRECTION_MIN_CONFIDENCE = 0.75;

/** Ceiling for each rung of the direction ladder, strongest first. */
export const DIRECTION_CONFIDENCE = {
  nonTaxDocument: 0.9,
  ambiguous: 0.2,
  issuerTaxId: 0.98,
  recipientTaxId: 0.98,
  issuerName: 0.85,
  recipientName: 0.85,
  noRecipient: 0.8,
  neitherParty: 0.3,
  unverifiedRecipient: 0.6,
  clientTaxIdMissing: 0.0,
  insufficient: 0.0,
  manual: 1.0,
} as const;

/** How many of a client's documents one reclassify pass will touch. */
export const RECLASSIFY_SCAN_LIMIT = 300;

/** Hebrew, like the field labels — this is bookkeeping vocabulary, not UI chrome. */
export const DIRECTION_LABEL: Record<DocDirection, string> = {
  income: 'הכנסה',
  expense: 'הוצאה',
  neither: 'לא רלוונטי',
  unknown: 'לא ידוע',
};

/**
 * What a human may choose. `unknown` is absent on purpose: it is a statement about the
 * system's own certainty, and there is no reason for a person to assert it — they are
 * looking at the document.
 */
export const DIRECTION_CHOICES: readonly DocDirection[] = ['income', 'expense', 'neither'];

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
