# FirmOffice — CPA Document Ingestion & Management System

## Context

An accounting firm needs to stop chasing clients for paperwork across email, WhatsApp, and ad-hoc channels. Today documents arrive scattered across an inbox and a phone; nobody can answer "what came in today, from whom, and has it been handled?"

This system gives clients one place to submit documents and accountants one Inbox-style dashboard where every document — regardless of how it arrived — appears with its original preview side-by-side with OCR-extracted text and a workflow status.

**Repo state:** `c:\Claude Projects\FirmOffice` is completely empty (git initialized, zero commits, remote `origin` → `github.com/matan958/FirmOffice`). Everything below is built from scratch.

**Decisions locked in this session:**
- Single firm, single Firebase project (not multi-tenant SaaS)
- Vite + React + TypeScript SPA on Firebase Hosting
- WhatsApp deferred to a later milestone — but the ingestion core is built channel-agnostic so it drops in
- English / LTR UI

> ⚠️ **One deviation from your spec, flagged deliberately:** you described "sidebar on the right, main area on the left." That is the natural *RTL* arrangement. Since you chose English/LTR I've planned sidebar-left / main-right to match convention. If you want it literally as written it's a single `flex-direction: row-reverse` — say the word.

---

## 1. System Architecture

### Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + React 18 + TS, React Router, Tailwind | SPA on Firebase Hosting; real-time via `onSnapshot`, no server layer to run |
| PDF/Image viewer | `react-pdf` (pdfjs-dist), self-hosted worker | Page-level rendering so the text panel can sync to the visible page |
| Auth | Firebase Auth + **Custom Claims** | Claims are the authorization source of truth (rules read the token, never a Firestore doc) |
| Files | Cloud Storage for Firebase | Originals, thumbnails, Vision async output, oversized-text overflow |
| Data | Cloud Firestore | Metadata, OCR text, client mappings, audit trail, live counters |
| Compute | Cloud Functions **Gen 2** (Node 20, TS) | Storage triggers, Firestore triggers, schedulers, callables, task handlers |
| Queue | **Cloud Tasks** (`onTaskDispatched`) | Retries with backoff, concurrency caps, isolates slow OCR from triggers |
| OCR | Google Cloud Vision API | Per spec; `DOCUMENT_TEXT_DETECTION` for images, file-batch APIs for PDFs |
| Secrets | Secret Manager | Gmail refresh token, WhatsApp tokens — never in env files or Firestore |

Requires the **Blaze** plan (Functions egress + Vision API).

### Repo shape

```
FirmOffice/
├── web/                    # Vite React SPA
│   ├── src/
│   │   ├── features/{auth,portal,inbox,viewer}/
│   │   ├── lib/firebase.ts
│   │   └── components/
├── functions/              # Cloud Functions Gen 2, TypeScript
│   └── src/
│       ├── ingest/         # channel adapters: web.ts, gmail.ts, whatsapp.ts
│       ├── core/           # ingestDocument.ts  ← the spine
│       ├── ocr/            # vision.ts, pdf.ts, tasks.ts
│       ├── mapping/        # resolveClient.ts
│       ├── admin/          # setUserRole.ts, getDocumentUrl.ts
│       └── jobs/           # janitor.ts, healthcheck.ts, retention.ts
├── shared/                 # TS types shared by web + functions (Document, Client, enums)
├── firestore.rules  firestore.indexes.json  storage.rules  firebase.json
```

`shared/` is worth the small setup cost: one canonical `Document` interface imported by both sides means a schema change can't silently desync the UI from the writer.

### End-to-end data flow

The central architectural idea: **channel adapters do one job — land bytes in Storage and create a `documents` record.** Everything after that is identical for all three channels.

```
┌─ WEB ────────────────────────────────────────────────────────────┐
│ Client drops file → SPA mints docId client-side                  │
│   → writes documents/{docId} {status: uploading}   ← instant UI  │
│   → uploadBytesResumable to incoming/{clientId}/{docId}/{name}   │
└──────────────────────────────────────────────────────────────────┘
┌─ GMAIL ──────────────────────────────────────────────────────────┐
│ Scheduled poller (5 min) → messages.list(has:attachment,         │
│   -label:Processed) → for each attachment:                       │
│   → resolveClient(headers) → ingestDocument(...)                 │
└──────────────────────────────────────────────────────────────────┘
┌─ WHATSAPP (deferred) ────────────────────────────────────────────┐
│ Meta webhook → return 200 in <5s → download media IMMEDIATELY    │
│   (URL expires in 5 min) → enqueue Task → ingestDocument(...)    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────────┐
        │ Storage onObjectFinalized (incoming/**)      │
        │  • sniff magic bytes → allowlist check       │
        │  • sha256 → duplicate check                  │
        │  • set contentType from sniffed type         │
        │  • doc → pipelineStatus: 'ocr_queued'        │
        │  • enqueue Cloud Task                        │
        └──────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────────┐
        │ OCR Task handler  (idempotent: bail if done) │
        │  image      → documentTextDetection(gcsUri)  │
        │  PDF ≤5pg   → batchAnnotateFiles (sync)      │
        │  PDF >5pg   → asyncBatchAnnotateFiles → LRO  │
        │  office/csv → skip OCR, store as-is          │
        │  • write ocr.* + /pages subcollection        │
        │  • generate page-1 thumbnail                 │
        │  • pipelineStatus: 'ocr_done'                │
        └──────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────────┐
        │ Firestore onDocumentWritten(documents/{id})  │
        │  • diff workflowStatus → increment counters  │
        │  • append immutable /events audit entry      │
        └──────────────────────────────────────────────┘
                              │
                              ▼
   SPA: onSnapshot(documents query) + onSnapshot(metrics/global)
   Preview bytes via callable getDocumentUrl() → 15-min V4 signed URL
```

**Why Cloud Tasks between the Storage trigger and Vision:** Storage triggers retry on failure with at-least-once semantics and no concurrency control. A client dragging 40 files in would fire 40 concurrent Vision calls; a transient 429 would retry the *whole trigger* including the duplicate check. Tasks give you `maxConcurrentDispatches`, exponential backoff, a dead-letter path, and a clean idempotency boundary. It's ~40 lines more than calling Vision inline and it's the difference between a demo and something that runs unattended.

### Why the preview is served via signed URL, not Storage rules

Accountants never get bucket read access in `storage.rules`. Instead a callable `getDocumentUrl({docId})` checks the caller's claim, mints a 15-minute V4 signed URL, and writes a `viewed` audit event. For a CPA firm, "who looked at which client's document, when" is a compliance-grade question — this makes it answerable for free.

> **Two deployment gotchas to handle in M0, not at 2am:**
> 1. Signing requires the Functions service account to hold `roles/iam.serviceAccountTokenCreator` **on itself**. The Gen 2 default SA does not have it.
> 2. `react-pdf` fetching a signed URL cross-origin needs **CORS configured on the GCS bucket** (`gsutil cors set`). Classic multi-hour debugging trap.

---

## 2. Client Mapping Strategy

The hardest problem in the system. An email or WhatsApp message arrives — which of the firm's clients does it belong to?

### The lookup table

```
/clientIdentifiers/{key}      // key IS the normalized identifier, e.g. "email:john@acme.com"
  type        : 'alias' | 'email' | 'domain' | 'phone' | 'subjectCode'
  value       : string
  clientId    : string
  confidence  : number         // default weight for this identifier type
  verified    : boolean
  source      : 'manual' | 'auto' | 'seed'
  createdBy, createdAt, lastMatchedAt, matchCount
```

Using the normalized identifier **as the document ID** is the key design choice: resolution is a single `getDoc()` — O(1), no query, no composite index — and Firestore's `create`-fails-if-exists gives you atomic uniqueness for free, so two clients can never claim the same email address.

### Gmail resolution ladder

Try in order, stop at first hit, record which rung matched:

| # | Method | Confidence | Notes |
|---|---|---|---|
| 1 | **Plus-address alias** — `docs+acme7k2@firm.com` | 1.00 | Each client gets a unique `ingestAlias`. Deterministic, survives forwarding, works from *any* sender address. |
| 2 | Exact sender email (normalized) | 0.95 | Lowercase, strip `+tag`, strip dots **only** for `@gmail.com` |
| 3 | Sender **domain** | 0.60 | Corporate clients with many employees |
| 4 | Subject-line code — `[ACME-123]` | 0.85 | Regex over the Subject header |
| 5 | Forwarded-message parse | 0.70 | Accountant forwards a client email → `From:` is the accountant. Detect `Fwd:`/`X-Forwarded-For`, parse the quoted `From:` in the body, re-run the ladder |
| 6 | Reply-To / envelope sender | 0.50 | When From is a mailing list or relay |
| — | **Unresolved** | — | `clientId: null`, `workflowStatus: 'pending'`, lands in the **Unassigned queue** |

**Make rung 1 the primary mechanism.** Onboarding each client with a personal drop address (`docs+acme7k2@firm.com`, printed on their engagement letter) converts the hardest rung of this ladder into a trivial one. Most designs skip it and then fight rungs 2–6 forever.

**Two mandatory guards:**

- **Public-domain blocklist on rung 3.** Without it, one `@gmail.com` domain identifier maps *every Gmail user on earth* to a single client. Block gmail/outlook/yahoo/hotmail/icloud/live/aol/proton and the local equivalents.
- **DKIM/SPF check before auto-assigning.** `From:` is trivially spoofable. Gmail exposes `Authentication-Results` in the message headers — if DKIM fails, downgrade confidence and route to Unassigned rather than filing a possibly-forged invoice into a real client's folder. For a CPA firm this is not paranoia.

### WhatsApp resolution ladder (design now, build in M5)

1. Normalize `wa_id` to E.164 with `libphonenumber-js` and an explicit `defaultCountry`. Meta returns bare digits; local `0501234567` and international `+972501234567` must collapse to the same key or you'll get silent misses.
2. `getDoc(clientIdentifiers/phone:+972501234567)`
3. Unresolved → auto-reply with a template asking for a client code, **and** file into Unassigned. Never drop it.

### The learning loop — this is what makes it work in production

When an accountant assigns an Unassigned document, the dialog offers a checkbox:

> ☑ Always file documents from `john@acme.com` under **Acme Ltd**

Checking it writes a `clientIdentifiers` doc with `source: 'manual', verified: true`. Manual assignment work trends toward zero as the firm's real-world identifier set gets captured. Without this loop, the Unassigned queue is a permanent tax; with it, it's a short onboarding phase.

Every document also stores how it was matched:

```ts
clientMatch: { method: 'alias'|'email'|'domain'|..., confidence: number,
               resolvedBy?: uid, resolvedAt: Timestamp }
```

The UI shows a small "verify?" affordance on low-confidence (domain) matches and nothing on high-confidence ones — so accountants only spend attention where it's warranted.

---

## 3. Firestore Schema

### `/users/{uid}`
```ts
{ role: 'client'|'accountant'|'admin',   // MIRROR — custom claims are authoritative
  email, displayName, photoURL,
  clientId: string|null,                 // set when role === 'client'
  active: boolean, createdAt, lastLoginAt }
```
Security rules read `request.auth.token.role`, **never** this doc — a rules `get()` costs a billed read and adds latency on every operation.

> Custom claims are capped at **1000 bytes** and only refresh on token renewal. After changing a role, force `getIdToken(true)` client-side and/or revoke refresh tokens, or the user keeps their old permissions until the token expires (up to 1 hour).

### `/clients/{clientId}`
```ts
{ name, legalName, taxId,
  primaryContactEmail, primaryContactPhone,
  ingestAlias: 'acme7k2',                 // → docs+acme7k2@firm.com
  status: 'active'|'archived',
  assignedAccountantIds: string[],
  counters: { pending, in_progress, processed },
  createdAt, updatedAt }
```

### `/documents/{docId}` — the core collection
```ts
{
  // ownership
  clientId: string | null,
  clientMatch: { method, confidence, resolvedBy?, resolvedAt },
  clientNameCache: string | null,          // denormalized so the inbox list needs no joins
  uploadedByUid: string | null,

  // provenance
  channel: 'web' | 'gmail' | 'whatsapp',
  source: {
    // gmail:    { messageId, threadId, from, subject, receivedAt, attachmentId, dkimPass, spfPass }
    // whatsapp: { waMessageId, waId, phoneNumberId, caption, receivedAt }
    // web:      { userAgent }
  },

  // file
  file: { originalName, storagePath, contentType, sizeBytes, sha256, pageCount? },
  thumbnailPath: string | null,
  duplicateOf: string | null,

  // ── TWO SEPARATE STATUS AXES ──
  pipelineStatus: 'uploading'|'received'|'ocr_queued'|'ocr_running'
                 |'ocr_done'|'ocr_failed'|'skipped_ocr'|'rejected',
  workflowStatus: 'pending' | 'in_progress' | 'processed',
  assignedAccountantUid: string | null,

  // OCR
  ocr: {
    engine: 'vision-v1',
    method: 'documentTextDetection'|'batchAnnotateFiles'|'asyncBatchAnnotateFiles'|'pdfTextLayer'|'none',
    fullText: string | null,        // inline ONLY when < ~200 KB
    textStoragePath: string | null, // overflow target when it isn't
    preview: string,                // first ~2000 chars — always present, powers list snippets
    pageCount, avgConfidence, lowConfidence: boolean,
    languageCodes: string[], completedAt, durationMs
  },
  extracted: { documentType?, invoiceNumber?, issueDate?,
               totalAmount?, currency?, vatAmount?, vendorName?, vendorTaxId? },  // M6

  error: { code, message, stage, attempts, lastAttemptAt } | null,

  receivedAt,    // when the CLIENT sent it (email Date / wa timestamp) — sort the inbox by this
  createdAt,     // when WE ingested it
  updatedAt,
  deletedAt: Timestamp | null    // soft delete
}
```

**The most important schema decision here: split status into two fields.**

Your spec has one status (`Pending` / `In Progress` / `Processed`) — but that's a *human workflow* state, and it must not be conflated with *machine pipeline* state. With one field, a document whose OCR fails either vanishes from the Pending count or shows an accountant a scary technical string. With two:

- **Metrics bar counts `workflowStatus` only** — exactly the three badges you specified
- **The document card shows a small pipeline chip** — a spinner while OCR runs, an amber "OCR failed · Retry" when it doesn't
- A document is `workflowStatus: 'pending'` from the moment it lands, **regardless of OCR outcome**. Nothing is ever invisible to the firm because a machine step failed.

### Subcollections
```
/documents/{docId}/pages/{pageNumber}    { text, confidence, width, height }
/documents/{docId}/events/{eventId}      { type, actor:{type,uid?}, from?, to?, meta?, at }
```
`events` is an append-only audit trail: `ingested`, `ocr_started`, `ocr_completed`, `ocr_failed`, `status_changed`, `reassigned`, `viewed`, `deleted`. Non-negotiable for a CPA firm's compliance posture — and it makes debugging ingestion trivial.

### `/metrics/global` — real-time badges
```ts
{ counts: { pending, in_progress, processed, unassigned, ocr_failed },
  byChannel: { web, gmail, whatsapp }, updatedAt }
```
Maintained by a Firestore `onDocumentWritten` trigger that diffs old/new `workflowStatus` and applies `FieldValue.increment(±1)`. The SPA holds one `onSnapshot` on this single doc.

*Why not `getCountFromServer()` aggregation queries?* They can't be subscribed to — no `onSnapshot` on aggregations — and you asked for real-time badges. The counter doc's only limit is ~1 sustained write/sec, which is orders of magnitude above CPA-firm volume. If it ever mattered, shard into 10 sub-docs; don't pre-build that.

### Operational collections
```
/ingestState/gmail        { lastHistoryId, lastPollAt, lastSuccessAt, lastError }
/processedMessages/{provider}:{externalId}   { docId, processedAt }   // idempotency ledger, TTL 90d
/failedIngestions/{id}    { payload, error, attempts, at }            // dead-letter
```

### Storage layout
```
incoming/{clientId|_unassigned}/{docId}/{originalName}
thumbnails/{docId}/page-1.jpg
ocr-output/{docId}/*.json          # Vision async output — lifecycle delete @ 7d
ocr-text/{docId}/fulltext.txt      # oversized-text overflow
quarantine/{docId}/{originalName}  # rejected / unsupported — lifecycle delete @ 30d
```

### Required composite indexes
```
documents: clientId ASC, receivedAt DESC                        # client portal
documents: workflowStatus ASC, receivedAt DESC                  # filtered inbox
documents: clientId ASC, workflowStatus ASC, receivedAt DESC
documents: channel ASC, receivedAt DESC
documents: pipelineStatus ASC, updatedAt ASC                    # janitor sweeps
```

> **Known limitation, decide before OCR starts writing:** Firestore cannot do substring or full-text search on `ocr.fullText`. Accountants *will* ask to search inside documents. Options: the Typesense/Algolia Firebase extension (best), or denormalizing a `searchTokens: string[]` at OCR time for `array-contains` keyword matching (free, crude). This affects the OCR writer, so choose in M2 — retrofitting means reprocessing every document.

### Security rules — the shape
```js
function isAccountant() { return request.auth.token.role in ['accountant','admin']; }
function isClient()     { return request.auth.token.role == 'client'; }
function myClientId()   { return request.auth.token.clientId; }

match /documents/{docId} {
  allow read:   if isAccountant()
             || (isClient() && resource.data.clientId == myClientId()
                            && resource.data.deletedAt == null);

  allow create: if isClient()
             && request.resource.data.clientId == myClientId()
             && request.resource.data.channel == 'web'
             && request.resource.data.workflowStatus == 'pending'
             && request.resource.data.pipelineStatus == 'uploading'
             && request.resource.data.keys().hasOnly([/* strict allowlist */]);

  // accountants may ONLY touch workflow fields — never ocr, file, channel, source
  allow update: if isAccountant()
             && request.resource.data.diff(resource.data).affectedKeys()
                  .hasOnly(['workflowStatus','assignedAccountantUid','clientId',
                            'clientMatch','clientNameCache','extracted','updatedAt']);

  allow delete: if false;   // soft delete only, via callable
}
```
Storage rules mirror this: clients get **create-only** into `incoming/{theirClientId}/**` with a size cap; nobody gets read (previews come from signed URLs). The Admin SDK bypasses rules entirely, so all server writes are unaffected.

---

## 4. Edge Cases & Error Handling

### Multi-page PDFs — Vision's real constraints

Vision **cannot** do synchronous `documentTextDetection` on a PDF at all. Three paths:

| Case | API | Notes |
|---|---|---|
| Digital-native PDF (has a text layer) | `pdf-parse` — **no Vision call** | Try first. If it yields >100 chars/page, you're done: instant and **free**. Meaningful saving vs ~$1.50/1000 pages |
| Scanned PDF ≤ 5 pages | `batchAnnotateFiles` (sync) | Inline response, fast. 5 pages is the hard sync limit |
| Scanned PDF > 5 pages | `asyncBatchAnnotateFiles` → LRO → GCS JSON | Output written to `ocr-output/{docId}/`, one JSON per 5-page batch |
| > 2000 pages | — | Vision's hard cap. Reject with a clear message, or split with `pdf-lib` in M6 |
| Password-protected | — | Detect via `pdf-lib` load failure → `error.code: 'PDF_ENCRYPTED'`, surface "password-protected" in the UI |

For the async path, poll the LRO from inside the Cloud Task with `operation.promise()`. A 50-page PDF typically finishes in 30–90s, well within the task timeout; if it does time out, Cloud Tasks retries and the idempotency guard restarts cleanly. Assemble pages using `context.pageNumber` from each response — **not** the output filename ranges, which are easy to get subtly wrong.

Write each page to `/documents/{docId}/pages/{n}` so the viewer's text panel can follow the visible PDF page. Cheap once pages are already separate, and a genuinely nice UX win.

### The 1 MiB problem

A Firestore document is capped at **1 MiB**. A dense 50-page scan's full text can exceed that, and the write will simply fail. Handle it at the writer:

- `< 200 KB` → inline in `ocr.fullText`
- `≥ 200 KB` → write to `ocr-text/{docId}/fulltext.txt`, set `ocr.textStoragePath`, leave `fullText: null`
- **Always** populate `ocr.preview` (first ~2000 chars) so list views and snippets never need a Storage fetch

### Unsupported and hostile files

- **Sniff magic bytes** (`file-type` package) — never trust the extension or the client-supplied MIME type; both are trivially forged. Set the stored `Content-Type` from the sniffed result.
- **Allowlist:** PDF, JPEG, PNG, WEBP, TIFF, BMP, GIF.
- **HEIC — decide this now.** Vision does not support it, and iPhone photos emailed or WhatsApp'd are frequently HEIC. Either convert (`heic-convert`, pure JS — `sharp` needs libheif which complicates the Functions runtime) or reject with a clear message. Silent failure here looks like "WhatsApp ingestion is broken."
- **Office docs / CSV** (`.xlsx` bank statements are common): **accept and store, skip OCR** — `pipelineStatus: 'skipped_ocr'`, `ocr.method: 'none'`. Never reject something a client legitimately sent just because you can't OCR it; the accountant can still open it.
- **Zero-byte / corrupt** → `rejected` → `quarantine/`, notify the client.
- **Size caps:** 20 MB for images (Vision's limit), 50 MB overall — enforced in `storage.rules` via `request.resource.size` **and** re-checked server-side.
- **Serving safety:** always `Content-Disposition: attachment`; never serve SVG or HTML inline from the bucket — that's a stored-XSS vector aimed at your accountants' browsers.

### OCR failures

| Failure | Response |
|---|---|
| Transient (429, 503, network) | Cloud Tasks exponential backoff, max 5 attempts → then `ocr_failed` |
| Permanent (corrupt, unsupported) | No retry. Straight to `ocr_failed` with a specific `error.code` |
| **Zero text extracted** | **Not a failure.** `ocr_done` with `textLength: 0` + UI hint "No text detected — is the image blurry or blank?" |
| Low confidence (< 0.6 avg) | `ocr.lowConfidence = true`, badge in the UI, offer re-upload |
| Quota exhaustion | `maxInstances` cap on the OCR function so a 200-file bulk upload can't drain quota in seconds |

A **manual Retry OCR button** in the dashboard (callable → re-enqueue the task) is essential ops kit, not a nice-to-have.

### Ingestion downtime

- **Gmail poller is stateless catch-up by design.** Querying `newer_than:2d -label:Processed/FirmOffice` means *any* outage under two days self-heals on the next successful run — no state reconciliation, no gap detection. Beyond two days, a manual backfill callable with a date range.
- **If you later adopt Gmail Pub/Sub push:** store `lastHistoryId`; on reconnect call `history.list(startHistoryId)`. Gmail only retains history ~1 week — on a 404 you must fall back to a full `messages.list` scan over the gap. And `users.watch` **expires every 7 days**; a daily scheduled renewal function is mandatory. This is the single most-forgotten piece of Gmail integrations.
- **WhatsApp (M5) — two hard ordering constraints:**
  1. Meta considers the webhook failed if you don't respond within ~5 seconds, and retries for up to 7 days. **Return 200 immediately, then process via Cloud Tasks.** Processing inline guarantees duplicates.
  2. Meta media URLs **expire in 5 minutes**. Download the bytes *synchronously before* enqueuing — if you queue first and download later, delayed tasks fetch dead URLs.
- **Idempotency everywhere:** write `/processedMessages/{provider}:{externalId}` in the **same transaction** as the document create. If the create fails the ledger entry rolls back, so the retry is safe rather than a no-op.
- **Dead-letter + alerting:** failures land in `/failedIngestions` with an alert. Nothing vanishes silently.
- **Janitor** (`every 30 minutes`): re-enqueue or fail out docs stuck in `uploading` >15 min or `ocr_running` >30 min. This is what catches the unknown unknowns.
- **Silent-failure alarm** (daily): alert if zero Gmail-channel documents arrived in 24h. "No new documents" is the worst failure mode — nobody notices until a filing deadline.

### Duplicates

Compute `sha256` at ingestion. Same hash + same `clientId` within 90 days → set `duplicateOf`, still store the file, but collapse it in the inbox. Clients genuinely re-send the same invoice by email *and* WhatsApp — routinely. Don't hard-reject (the second copy may carry a different caption or context); surface and fold it.

### Timestamps

Store everything as Firestore `Timestamp` (UTC); render in the firm's timezone. Keep `receivedAt` (when the client sent it) separate from `createdAt` (when we ingested it) — after a poller outage recovers they diverge sharply, and **sorting the inbox by `receivedAt`** is what keeps the order sane.

### Concurrency & retention

- Two accountants on the same doc: last-write-wins plus an `events` entry. A small firm doesn't need locking — don't over-engineer it.
- Soft delete + scheduled hard-delete after N days; Storage lifecycle rules on `ocr-output/` (7d) and `quarantine/` (30d); Firestore TTL policy on `/processedMessages` (90d); scheduled Firestore export for backup.

---

## 5. Implementation Roadmap

### M0 — Foundations · ~2–3 days
Firebase project on Blaze, Vision API enabled. `firebase init` (hosting, firestore, storage, functions, **emulators**). Vite + React + TS + Tailwind + React Router scaffold. `shared/` types package. `.gitignore`, GitHub Actions → `firebase deploy`, Secret Manager.
**Do the two gotchas here:** grant `roles/iam.serviceAccountTokenCreator`, configure GCS CORS.
→ *Empty app deployed, emulators running locally.*

### M1 — Auth & RBAC · ~3 days
Email/password login with role selection. Client self-signup; accountants invite-only via an admin callable. `setUserRole` callable writing custom claims + the `/users` mirror. Route guards, `AuthProvider`, forced token refresh on role change. `firestore.rules` + `storage.rules` v1 **with unit tests** (`@firebase/rules-unit-testing`) — write these now, not later; they are the security boundary.
→ *A client and an accountant log in and land on different shells.*

### M2 — Web upload + OCR core · ~5 days ← **the spine**
Minimal `/clients` CRUD. Drag & drop → resumable upload → doc record → Storage trigger → Cloud Task → Vision. Build **`ingestDocument({ buffer, filename, contentType, channel, source, clientHint })`** — the single channel-agnostic entry point all three channels call. Doing this now is exactly what makes M4 and M5 cheap. PDF sync/async branching, `pages` subcollection, oversized-text overflow, counter trigger, audit events. **Decide the search strategy here.**
→ *End-to-end: drop a file, see OCR text in Firestore.*

### M3 — Accountant Dashboard · ~5 days
Real-time inbox list (paginated, filter by status/client/channel). Split viewer: `react-pdf` / image viewer + OCR text panel with page sync. Status management + live metrics bar. Signed-URL preview fetching, Retry-OCR button, Unassigned queue UI.
→ **Ship it here.** The firm can use the system with web uploads alone. Get real feedback before touching Gmail.

### M4 — Gmail ingestion · ~4 days
OAuth (or Workspace domain-wide delegation) with the refresh token in Secret Manager. Scheduled poller + the `clientIdentifiers` resolution ladder + per-client plus-address aliases. Inline-image filtering (see below), idempotency ledger, Gmail `Processed/` labels, DKIM gating. **The "always map this sender" learning loop** in the Unassigned UI.
→ *Emailed attachments appear in the inbox, auto-filed.*

> **Gmail attachment gotchas to budget for:** inline images (`Content-ID` present, small, `image/*`) are email signature logos — filter them or every message spawns a junk document. Handle base64**url** decoding (`-`/`_`, not `+`/`/`). Attachments >25 MB aren't in Gmail at all — they become Drive links in the body. `.zip` and forwarded `.eml` attachments: reject with notice in M4, support in M6.

### M5 — WhatsApp · ~4 days *(deferred per your call)*
Webhook verify handshake, 200-then-async, 5-minute media download window, E.164 normalization, phone identifier ladder.
> **Start the Meta Business verification paperwork during M3.** It's little dev work but often **1–2 weeks of calendar time**. It's the only true external dependency in this plan and the only thing that can't be compressed by working harder.

### M6 — Hardening & ops · ~4 days
Janitor + health-check schedules, dead-letter alerting, GCP budget alarms + per-day ingestion caps. Structured extraction (invoice #, date, total, VAT) via regex heuristics — with a clean seam to swap in Document AI's Invoice Parser later. Search implementation. Retention/soft-delete jobs, scheduled Firestore export, load test.

**≈ 5–6 weeks focused solo for M0–M4 + M6, plus M5.**

---

## Verification

- **Rules tests** (`@firebase/rules-unit-testing`, run in CI): a client cannot read another client's document; a client cannot set `workflowStatus: 'processed'` on create; an accountant cannot overwrite `ocr.fullText`; an unauthenticated read is denied.
- **Emulator integration test:** seed a client + identifier → drop a 3-page scanned PDF through the web path → assert `pipelineStatus: 'ocr_done'`, 3 `pages` docs, `metrics/global.counts.pending` incremented by exactly 1.
- **Idempotency test:** invoke the OCR task handler twice with the same `docId` → exactly one set of page docs, counters unchanged on the second run.
- **Mapping test matrix:** feed synthetic Gmail payloads covering each ladder rung — alias hit, exact email, corporate domain, `@gmail.com` sender (must **not** domain-match), forwarded message, DKIM-fail — and assert the resulting `clientMatch.method` and `confidence`.
- **Edge-case corpus:** a fixture folder with a 200-page PDF, an encrypted PDF, a HEIC, a 0-byte file, a `.xlsx`, a blank white scan, and a `.jpg` renamed to `.pdf`. Every one must land in a defined terminal state with a specific `error.code` — none may hang in `ocr_running`.
- **Manual end-to-end:** upload from the Client Portal → confirm it appears in the accountant's inbox within ~5s → open the split view, verify the preview renders and the text panel follows page changes → flip status → watch the metrics badge update live in a second browser.

---

## Open Items

| # | Item | Needed by |
|---|---|---|
| 1 | Meta Business verification — **start early** | Before M5 |
| 4 | Google Workspace (domain-wide delegation) or plain Gmail (OAuth refresh token)? | M4 |
| 5 | Firm timezone + expected daily document volume (sizes the counter/quota decisions) | M2 |

### Resolved 2026-08-08

| # | Item | Decision |
|---|---|---|
| 2 | HEIC | **Convert on ingest** via `heic-convert`. Rejecting reads to a client as a broken upload. |
| 3 | Search | **`searchTokens` array.** Keeps client financial text inside the firm's own project. Whole-word matching only. Retrofitting to a real engine is a backfill over retained full text, not a re-OCR — the note above overstated the lock-in. |
