# FirmOffice

CPA document ingestion & management system. Clients submit documents through several
channels; accountants work them from a single Inbox-style dashboard with the original
preview side-by-side with OCR-extracted text.

Full architecture, schema rationale, and edge-case handling: **[`docs/PLAN.md`](docs/PLAN.md)**.

**Live at <https://firmoffice-9b247.web.app>** — deployed 2026-08-09. A document
arrives in the Client Portal, and is validated, hashed, de-duplicated, OCR'd and
indexed, with live counters and an audit trail. Accountants work it from an Inbox with
the original and the extracted text side by side.

All 15 functions are deployed to `us-east1`. Bucket CORS, the IAM URL-signing grant
and the Vision API were re-verified against the project at deploy time.

Proven end to end on `firmoffice-9b247` on 2026-08-08: magic-byte sniffing, SHA-256
duplicate detection, the free PDF text-layer path, search tokens, the pages
subcollection, Cloud Tasks dispatch with retry, and nested metrics counters.

**Verified end to end on the live project, 2026-08-10.** A client uploaded a document
through the portal; Cloud Vision read it; an accountant opened it and saw the original
beside the extracted text. That closes the two things that had been configured but
never exercised — **Cloud Vision** and **signed-URL previews** (`getDocumentUrl`,
whose IAM signing grant and bucket CORS produce errors naming neither when absent).

**Gmail ingestion is live, 2026-08-13.** The poller runs every five minutes against the
firm's mailbox and completes cleanly. Getting there cost four hours almost entirely to
one thing: a client secret pasted twice into Secret Manager. It began with `GOCSPX-`, so
every shape check passed it, and a doubled secret is exactly as invalid as a wrong one —
Google reports both as `invalid_client`. Length was the only signal that separated them
and nothing was looking at length. The client now logs, once per cold start, the
credentials it actually loaded: the client ID whole (it is public — it travels in every
consent URL), and the other two by length and prefix. See
[Connecting Gmail](#connecting-gmail-m4).

---

## Layout

```
shared/      Canonical data model. The ONE definition of every Firestore shape;
             imported verbatim by both web/ and functions/.
web/         Vite + React + TS SPA (Client Portal + Accountant Dashboard).
functions/   Cloud Functions Gen 2 (Node 22, ESM) + the security-rules test suite.
scripts/     One-off ops scripts.
```

`shared/` is compiled into `functions/lib` via `rootDir: ".."` rather than linked as an
npm workspace — the Functions deploy packager does not follow workspace symlinks.
`web/` reaches it through the `@shared` Vite alias.

## Two status axes

The single most load-bearing modelling decision, so it is worth stating up front:

| Field | Values | Purpose |
|---|---|---|
| `workflowStatus` | `pending` · `in_progress` · `processed` | Human state. **This alone** feeds the metrics bar. |
| `pipelineStatus` | `uploading` … `ocr_done` · `ocr_failed` · `rejected` | Machine state. Drives a small chip on the document card. |

A document is `pending` from the moment it lands, *regardless of OCR outcome*. Nothing
is ever invisible to the firm because a machine step failed.

## Deployed topology

| Piece | Location | Notes |
|---|---|---|
| Firestore | **`nam5`** (US multi-region) | Permanent. Higher availability; roughly double the per-operation cost of a single region. |
| Storage bucket | **`us-east1`** | `firmoffice-9b247.firebasestorage.app`, created here by default. |
| Cloud Functions | **`us-east1`** | `FUNCTIONS_REGION`. Must match the bucket — see below. |

`nam5` was chosen deliberately on 2026-08-08 after the CLI created the database there
by default. It replicates across US regions, which suits a compliance-sensitive
document archive; the trade is per-operation cost.

> **`FUNCTIONS_REGION` must equal the bucket's region.** Gen 2 storage triggers are
> delivered by Eventarc, which refuses a cross-region subscription: the deploy fails
> with *"a function in region X cannot listen to a bucket in region Y"*. This is a hard
> constraint, not a latency preference. Functions were moved to `us-east1` to match the
> bucket, because moving a function is one constant and moving the default bucket is
> not.

Firestore's region is independent — any US function region can reach `nam5`.

## Roles & access

Authorization lives in the ID token's **custom claims** (`role`, `clientId`) — never in
a Firestore document. Rules read the token directly, so authorizing a request costs no
billed read.

| Role | Gets it by | Can see |
|---|---|---|
| `client` | self-signup at `/signup` | only their own documents, and only once **linked** |
| `accountant` | an admin runs `setUserRole` | every document, the client list, firm metrics |
| `admin` | `scripts/grant-admin.mjs`, then `setUserRole` | the above, plus role assignment |

**Signup grants a role but no access.** A self-registered user gets `role: 'client'`
with *no* `clientId` claim, and every client rule is gated on
`isLinkedClient()` — `isClient() && myClientId() != ''`. Without that guard an
unlinked user's `myClientId()` evaluates to `''`, which would match any document whose
`clientId` was also `''`. Two rules tests exist purely to pin that down; they fail if
the guard is removed. Until an accountant links them, the user sits on `/pending`.

Creating the first admin is a chicken-and-egg — `setUserRole` is admin-only. Sign up
through the app, then:

```bash
npm run grant-admin -- you@example.com --emulator   # local
npm run grant-admin -- you@example.com              # real project (needs ADC)
```

Role changes revoke the target's refresh tokens, because an existing ID token keeps its
old claims for up to an hour otherwise. The SPA listens on `onIdTokenChanged`, so new
claims land without a re-login.

---

## Local development

Requires **Node 22+** and a **JDK** (the Firestore and Storage emulators are Java).

```bash
npm run install:all              # all four packages
cp web/.env.example web/.env.local   # then fill it in

npm run emulators                # terminal 1 — Auth, Firestore, Storage, Functions, Tasks
npm run dev                      # terminal 2 — Vite on :5173
```

Open <http://localhost:5173/health>. It should report the project ID, `Emulator suite`,
and a reachable Functions callable. Emulator UI is on <http://localhost:4000>.

| Command | Does |
|---|---|
| `npm run typecheck` | All three packages |
| `npm run build` | Functions `tsc` + web production bundle |
| `npm run rules:test` | Boots the Firestore emulator and runs the rules suite |
| `npm run deploy` | Build, then deploy everything |
| `npm run deploy:rules` | Rules + indexes only (fast, safe iteration) |
| `npm run set-cors` | Applies `cors.json` to the Storage bucket |
| `npm run gmail-auth` | One-off OAuth flow that mints the poller's refresh token |

### Windows note

The Firestore emulator's JVM sometimes survives `SIGINT` and keeps port 8080, which
makes the next run fail with *"port taken"*. Clear it with:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

A `NullPointerException` from the rules runtime **during shutdown** is cosmetic — the
runtime's stdin closes before its read loop ends. It is not a rules error.

---

## ⚠️ Manual setup — required before anything can be deployed

None of this can be scripted; it needs a Google account with billing.

1. **Create the Firebase project.** Note the project ID.
2. **Upgrade to the Blaze plan.** Mandatory: Cloud Functions cannot make outbound calls
   (Vision, Gmail, Meta) on Spark.
3. **Set a budget alert** in Cloud Billing before anything else runs. Vision is roughly
   $1.50 per 1000 pages and a misconfigured poller can reprocess an entire inbox.
4. **Enable APIs.** Free — you pay for usage, not for enabling. From Cloud Shell:
   ```bash
   gcloud services enable \
     compute.googleapis.com iamcredentials.googleapis.com \
     cloudfunctions.googleapis.com run.googleapis.com \
     cloudbuild.googleapis.com artifactregistry.googleapis.com \
     eventarc.googleapis.com vision.googleapis.com \
     cloudtasks.googleapis.com cloudscheduler.googleapis.com \
     secretmanager.googleapis.com gmail.googleapis.com --project=<PROJECT_ID>
   ```
   `compute` and `iamcredentials` are the two that are easy to miss and hard to
   diagnose: **enabling Compute Engine is what creates the default service account**
   that step 9 grants a role to, and without it that step fails with
   *"Unknown service account"*. `iamcredentials` is what actually signs the URLs.
5. **Create Firestore** (Native mode) and a **Storage bucket**, both in the US.
   > **Do this in the console, deliberately.** `firebase deploy --only
   > firestore:rules,firestore:indexes` will silently CREATE the database if none
   > exists, picking its own default location — and a Firestore location is
   > **permanent**. The only fix is deleting and recreating, which is free only while
   > the database is still empty.
6. **Enable the Email/Password provider** — Authentication → Sign-in method. Nothing in
   M1 works without it: sign-in fails with `auth/operation-not-allowed`, which does not
   obviously mean "you skipped a console toggle". The emulator allows it by default, so
   this only bites on the real project.
7. **Register a Web app**, then paste the config into `web/.env.local`.
8. **Put the real project ID in `.firebaserc`** (replacing `REPLACE_WITH_…`).
9. **Grant the signing permission.** Requires step 4 to have run first — the service
   account this names does not exist until Compute Engine is enabled. Signed preview
   URLs fail without this grant, and the error message does not say so:
   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     <PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
     --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
     --role="roles/iam.serviceAccountTokenCreator" --project=<PROJECT_ID>
   ```
10. **Apply bucket CORS.** `react-pdf` fetches signed URLs cross-origin with byte-range
    requests; without this the viewer fails pointing nowhere near the cause. Edit the
    origins in `cors.json`, then either `npm run set-cors` (needs
    `gcloud auth application-default login`) or, from **Cloud Shell**:
    ```bash
    gcloud storage buckets update gs://<BUCKET> --cors-file=cors.json
    ```
11. **Deploy indexes and rules first:** `npm run deploy:rules`.
12. **CI secrets** (GitHub → Settings → Secrets and variables → Actions): the six
    `VITE_FIREBASE_*` values plus `FIREBASE_SERVICE_ACCOUNT` (a service-account JSON key
    with Firebase Admin, Cloud Functions Admin, Cloud Datastore Owner, Service Account
    User). Then, on the **Variables** tab, set `DEPLOY_ENABLED` to `true` — CI's deploy
    job is gated off until you do, so `verify` runs on every push but nothing tries to
    deploy into a project that does not exist yet.

Storage lifecycle rules (`ocr-output/` 7d, `quarantine/` 30d) are set in the console,
as is the Firestore **TTL policy on `processedMessages`, keyed on the `expiresAt`
field**. That collection is the idempotency ledger: one row per mail attachment ever
ingested, written forever unless the policy is in place to sweep them.

---

## Connecting Gmail (M4)

Documents arrive by mail as well as through the portal. A scheduled poller reads the
firm's mailbox every five minutes, filters real attachments out of email furniture,
works out which client each one belongs to, and hands the bytes to the same ingest
spine the portal uses.

### How a message finds its client

**A client IS their registered email address.** Mail from it files itself; mail from
anywhere else waits in Unassigned until a human decides. That is the firm's rule and it
is enforced as a flag on the rung — `Hit.assigns` — rather than as a confidence
threshold, because a threshold expressing the same thing would break silently the moment
anyone retuned a number in `MATCH_CONFIDENCE`.

The other rungs still run. They cannot file, but they can NAME a candidate, which is the
difference between "Unassigned, good luck" and a one-click *"file under Acme Ltd?"*.

| # | Rung | Confidence | Files? | Notes |
|---|---|---|---|---|
| 1 | Drop address — `you+acme7k2@gmail.com` | 1.00 | suggests | Not surfaced in the UI; the addresses are no longer handed out |
| 2 | **Exact sender address** | 0.95 | **FILES** | Normalized: lowercased, `+tag` stripped, dots stripped for Gmail only |
| 3 | Subject code — `[ACME-123]` | 0.85 | suggests | |
| 4 | Forwarded original sender | 0.70 | suggests | Parsed from the quoted `From:` when an accountant forwards a client's mail |
| 5 | Sender domain | 0.60 | suggests | Corporate clients with several staff. **Never** a public mailbox provider |
| 6 | Reply-To | 0.50 | suggests | |

Rungs are tried strongest first and the first hit wins, so ordering still matters even
though only one can file: the rung that wins is the one whose candidate gets offered,
and offering the wrong client is a mistake an accountant can accept in one click.

The 0.60 floor still applies **on top of** the flag. An exact-address match whose DKIM
and SPF both failed scores 0.48 and drops to a suggestion — which is exactly what a
forged invoice should do.

> **The plan's table ordered these differently** — domain (0.60) above subject code
> (0.85) and forwarded (0.70). With "stop at the first hit" that lets a weak domain
> match pre-empt a strong subject code on the same message. First-hit-wins is only
> sound if the rungs are sorted by confidence.

**Sender authentication.** `From:` is plain text anyone can write. If Gmail's own
`Authentication-Results` header says both DKIM and SPF failed, sender-derived rungs are
halved, which drops it below the auto-file floor. DKIM and SPF are treated as
alternatives rather than both being required: plenty of small businesses never sign with
DKIM, and exiling them to Unassigned permanently trains accountants to click through the
queue without reading it. The drop address and subject code are not gated on this — they
are tokens the firm issued, not identity claims — but neither can file anyway.

**The learning loop.** Filing an unassigned document offers *"always file mail from
john@acme.com under Acme Ltd"*, which creates the identifier and re-files everything
already waiting from that sender. This is what decides whether Unassigned is a short
onboarding phase or a permanent tax.

### What you have to do — a single private Gmail account

Roughly 15 minutes in the console, all free. **Step 3 is the one that silently breaks
things a week later.**

1. **Enable the Gmail API** for the project (APIs & Services → Library → Gmail API).
2. **Configure the OAuth consent screen** (APIs & Services → OAuth consent screen):
   User Type **External**, add your own address as a test user, and add the scope
   `https://www.googleapis.com/auth/gmail.modify`.
3. **Publish the app — set publishing status to "In production".**
   > Google expires refresh tokens issued by an app still in **Testing** after
   > **seven days**. The poller would work for a week and then stop, and a mailbox that
   > yields no documents looks exactly like a quiet week. Publishing is a button; as
   > the only user of your own app you then click through the "Google hasn't verified
   > this app" screen (Advanced → Go to…). Verification is only needed to remove that
   > warning for *other* people.
4. **Create an OAuth client** (Credentials → Create credentials → OAuth client ID) with
   application type **Desktop app**. That type accepts loopback redirects without
   registering redirect URIs.
5. **Mint the refresh token**, which opens a browser and verifies the result actually
   reads your mailbox before printing anything:
   ```bash
   npm run gmail-auth -- --client-id=<ID> --client-secret=<SECRET>
   ```
6. **Store the three secrets** (each command reads the value from stdin):
   ```bash
   npx firebase functions:secrets:set GMAIL_CLIENT_ID
   npx firebase functions:secrets:set GMAIL_CLIENT_SECRET
   npx firebase functions:secrets:set GMAIL_REFRESH_TOKEN
   ```
7. **Set the Firestore TTL policy** on `processedMessages`, keyed on `expiresAt`
   (console only). That collection gets one row per attachment ever ingested and grows
   without bound until the policy exists.
8. **Uncomment the export** in `functions/src/index.ts` — it is commented out precisely
   because the secrets above did not exist yet, and a deploy fails outright on a
   declared secret with no version:
   ```ts
   export { pollGmail, pollGmailNow } from './gmail/poll.js';
   ```
   > Skip this and every other step still succeeds, the deploy is clean, and nothing
   > whatsoever happens — which is the same failure this whole channel is built to make
   > visible, so it should not be the one the instructions cause.
9. **Deploy**, then open the Inbox. The strip under the metrics bar shows the mailbox
   the token belongs to and when the poller last completed a run; admins get a
   **Check now** button so you need not wait for a tick. Until the first successful run
   the strip is hidden entirely and the Clients page shows "pending — mail ingestion not
   connected", so the strip appearing is the real proof.
10. **Set each client's email** on the Clients page. That address is the only thing that
    files a document automatically — a client with none will have every message land in
    Unassigned, with nothing on screen explaining why, which is why the column shows an
    amber "not set — mail will not file" rather than a blank.

To rotate or repoint the mailbox, re-run steps 5–6 and redeploy. The poller re-reads the
account's own address on every run, so nothing about the mailbox is configured twice.

### Operational notes

- **Polling, not push.** Gmail's `users.watch` subscription **expires every 7 days** and
  needs a daily renewal function, plus history-cursor handling with a full-scan fallback
  for when Gmail's ~1 week of history has aged out. Polling a fixed 2-day window keeps
  no cursor at all: any outage shorter than the window self-heals on the next run, and
  the idempotency ledger discards what is already held. The cost is latency measured in
  minutes.
- **Idempotency keys are `gmail:{messageId}.{partIndex}`, not the attachment ID.** Gmail
  does not promise `attachmentId` is the same value on a later fetch of the same
  message, so keying on it would re-ingest the whole window every five minutes.
- **`receivedAt` is Gmail's `internalDate`, not the `Date:` header.** That header is
  written by the sender's machine; a skewed clock dates a message in 2030 and pins it to
  the top of an inbox sorted by `receivedAt`, permanently.
- **Inline images are filtered** by `Content-ID` plus a size ceiling, not by size alone —
  a phone mail client genuinely sends real receipts inline.
- **Archives, `.eml` and files over 50 MB are refused, not stored**, and the message is
  labelled `FirmOffice/Attention` rather than `FirmOffice/Processed` so it stays visible
  in the mailbox. Attachments over 25 MB are not in the message at all — Gmail replaces
  them with Drive links, which are detected and flagged.
- **Cost.** Gmail API calls are free. One Cloud Scheduler job is inside the free tier of
  three. 8,640 invocations a month is a rounding error against the 2M free tier. The
  real variable cost is Vision, on scanned attachments only.

---

## Open items

Decisions the plan deliberately left to you, with the milestone that forces them:

| # | Item | Needed by |
|---|---|---|
| 1 | Meta Business verification — **start the paperwork early**, 1–2 weeks of calendar time | before M5 |
| 5 | Firm timezone + expected daily document volume | M2 |

### Decided

- **Gmail auth → OAuth refresh token in Secret Manager** (2026-08-08, open item #4).
  A single private Gmail account, so Workspace domain-wide delegation is not available
  and not needed. The consequence to watch is the consent screen's publishing status:
  see step 3 of [Connecting Gmail](#connecting-gmail-m4).

- **HEIC → convert on ingest** (2026-08-08). `heic-convert` (pure JS; `sharp` needs
  libheif, which complicates the Functions runtime). Rejecting would read to a client
  as "your upload failed", and iPhones send HEIC constantly.
- **Search → denormalized `searchTokens` array** (2026-08-08). Free, no extra vendor,
  and no continuous copy of clients' financial text into third-party SaaS — which for
  a CPA firm is a confidentiality question, not just a technical one. The cost is whole
  -word matching only: no prefix, typo tolerance or ranking.

  This is **less locked-in than it looks**. Full text is always retained (inline under
  200 KB, spilled to `ocr-text/` above), so moving to Typesense/Algolia later is a
  backfill over stored text — Vision is never paid for twice. The irreversible mistake
  would be discarding full text to save space; the schema deliberately does not.

## Roadmap

- [x] **M0** Foundations — scaffold, rules, emulators, CI
- [x] **M1** Auth & RBAC — custom claims, route guards, full rules test matrix
- [x] **M2** Web upload + OCR core — ingest trigger, Vision, counters, audit trail
      *(core verified live)*
- [x] **M3** Accountant Dashboard — inbox, split viewer, status management *(shippable)*
      *(built against emulators; signed-URL previews not yet exercised on the real
      project. Page-1 thumbnails and the Unassigned "always file from this sender"
      learning loop are deferred — the latter needs a sender address, which only
      exists once Gmail ingestion lands in M4.)*
- [x] **M4** Gmail ingestion — poller, mapping ladder, learning loop
      *(built and unit-tested against synthetic payloads; **not deployed**. The
      exports are commented out in `functions/src/index.ts` because they declare
      secrets that do not exist yet — see [Connecting Gmail](#connecting-gmail-m4).)*
- [ ] **M5** WhatsApp ingestion
- [ ] **M6** Hardening — janitor, alerting, structured extraction, search, retention
