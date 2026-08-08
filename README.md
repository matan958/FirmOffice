# FirmOffice

CPA document ingestion & management system. Clients submit documents through several
channels; accountants work them from a single Inbox-style dashboard with the original
preview side-by-side with OCR-extracted text.

Full architecture, schema rationale, and edge-case handling: **[`docs/PLAN.md`](docs/PLAN.md)**.

**Status: M1 complete** — auth, roles, and route guards work end to end. Clients can
sign up and accountants can sign in; document ingestion (M2) is next.

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
| Cloud Functions | `us-central1` | `FUNCTIONS_REGION`. Inside `nam5`, so no cross-region latency. |
| Storage bucket | `firmoffice-9b247.firebasestorage.app` | Keep in the US, alongside the above. |

`nam5` was chosen deliberately on 2026-08-08 after the CLI created the database there
by default. It replicates across US regions, which suits a compliance-sensitive
document archive; the trade is per-operation cost.

`FUNCTIONS_REGION` stays `us-central1` — it names where *functions* run, not where
Firestore lives, and the two do not have to match.

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
     secretmanager.googleapis.com --project=<PROJECT_ID>
   ```
   `compute` and `iamcredentials` are the two that are easy to miss and hard to
   diagnose: **enabling Compute Engine is what creates the default service account**
   that step 9 grants a role to, and without it that step fails with
   *"Unknown service account"*. `iamcredentials` is what actually signs the URLs.
   (Gmail API in M4.)
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

Storage lifecycle rules (`ocr-output/` 7d, `quarantine/` 30d) and the Firestore TTL
policy on `processedMessages` are set in the console; they matter from M2 onward.

---

## Open items

Decisions the plan deliberately left to you, with the milestone that forces them:

| # | Item | Needed by |
|---|---|---|
| 1 | Meta Business verification — **start the paperwork early**, 1–2 weeks of calendar time | before M5 |
| 4 | Gmail auth: Workspace domain-wide delegation, or a plain mailbox + OAuth refresh token in Secret Manager? | M4 |
| 5 | Firm timezone + expected daily document volume | M2 |

### Decided

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
- [ ] **M2** Web upload + OCR core — `ingestDocument()`, Vision, counters, audit trail
- [ ] **M3** Accountant Dashboard — inbox, split viewer, status management *(shippable)*
- [ ] **M4** Gmail ingestion — poller, mapping ladder, learning loop
- [ ] **M5** WhatsApp ingestion
- [ ] **M6** Hardening — janitor, alerting, structured extraction, search, retention
