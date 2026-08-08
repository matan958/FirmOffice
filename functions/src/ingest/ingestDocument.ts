import { logger } from 'firebase-functions';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { bucket, db } from '../lib/firebase.js';
import type { ServerWrite } from '../lib/model.js';
import {
  COLLECTIONS,
  incomingPath,
  processedMessageKey,
  safeObjectName,
} from '../shared.js';
import type {
  Channel,
  ClientMatch,
  DocumentDoc,
  DocumentSource,
  ProcessedMessageDoc,
} from '../shared.js';

/**
 * The one channel-agnostic ingest entry point.
 *
 * A channel adapter's entire job is to land bytes and create a `documents` record;
 * everything downstream — sniffing, hashing, de-duplication, HEIC conversion, OCR,
 * counters, audit trail — is the existing Storage trigger, identical for every
 * channel. The web portal reaches this same spine from the browser (it writes the
 * record itself, under rules that allow exactly those fields); Gmail and WhatsApp
 * come through here because they have no browser to do it.
 *
 * ── Ordering, and the one failure it leaves behind ──
 *
 * The record and the idempotency ledger entry are written in ONE batch, before the
 * bytes move. That ordering is what makes retries safe: if the batch fails, nothing
 * was recorded and the next poll re-ingests; if it succeeds, the ledger blocks a
 * second copy of the same message.
 *
 * The gap is between the batch and the upload. A crash there leaves a document stuck
 * in `uploading` with a ledger entry that stops the poller retrying it. Both are
 * cleaned up explicitly on a failed upload, and the M6 janitor sweeps anything that
 * outlives the process itself. The alternative ordering — bytes first — trades a
 * visible stuck document for an invisible orphaned object, which is strictly worse:
 * a stuck document is something someone can see and fix.
 */

export interface IngestInput {
  bytes: Buffer;
  /** As the sender named it. Preserved verbatim on the record; sanitized for the path. */
  originalName: string;
  /** Declared type. The Storage trigger re-sniffs the magic bytes and corrects it. */
  contentType: string;
  channel: Channel;
  source: DocumentSource;
  /** When the CLIENT sent it — the email Date header, not now. */
  receivedAt: Date;
  clientId: string | null;
  clientName: string | null;
  clientMatch: Omit<ClientMatch, 'resolvedAt'>;
  /**
   * Idempotency key WITHOUT the provider prefix, e.g. `19806f2a1c.2` for the third
   * attachment of a message. Null for channels that have no external message ID.
   */
  externalId: string | null;
}

export type IngestOutcome =
  | { status: 'ingested'; docId: string }
  /** The ledger already had this externalId — a redelivery, not a new document. */
  | { status: 'already_ingested'; docId: string };

export async function ingestDocument(input: IngestInput): Promise<IngestOutcome> {
  const ledgerKey = input.externalId
    ? processedMessageKey(input.channel, input.externalId)
    : null;
  const ledgerRef = ledgerKey ? db().doc(`${COLLECTIONS.processedMessages}/${ledgerKey}`) : null;

  // Cheap pre-check. The batch's create() below is the real guard — this only avoids
  // downloading and re-uploading megabytes for a message we already hold, which on a
  // poller that re-scans a two-day window is the overwhelmingly common case.
  if (ledgerRef) {
    const existing = await ledgerRef.get();
    if (existing.exists) {
      return {
        status: 'already_ingested',
        docId: (existing.data() as ProcessedMessageDoc).docId,
      };
    }
  }

  const docRef = db().collection(COLLECTIONS.documents).doc();
  const docId = docRef.id;
  const storagePath = incomingPath(input.clientId, docId, safeObjectName(input.originalName));

  const document: ServerWrite<DocumentDoc> = {
    clientId: input.clientId,
    clientMatch: { ...input.clientMatch, resolvedAt: FieldValue.serverTimestamp() },
    clientNameCache: input.clientName,
    uploadedByUid: null,

    channel: input.channel,
    source: input.source,

    file: {
      originalName: input.originalName,
      storagePath,
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
      // Filled by the ingest trigger once it has read the bytes itself. A hash the
      // sender could influence is not worth checking.
      sha256: '',
    },
    thumbnailPath: null,
    duplicateOf: null,

    // 'uploading' is what the Storage trigger's idempotency guard looks for; anything
    // else and it treats the object as already processed and silently does nothing.
    pipelineStatus: 'uploading',
    // Pending from the moment it lands, whatever OCR later does with it.
    workflowStatus: 'pending',
    assignedAccountantUid: null,
    statusActorUid: null,

    ocr: null,
    searchTokens: [],
    extracted: {},
    error: null,

    receivedAt: Timestamp.fromDate(input.receivedAt),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    deletedAt: null,
  };

  const batch = db().batch();
  batch.set(docRef, document);

  if (ledgerRef) {
    const ledger: ServerWrite<ProcessedMessageDoc> = {
      docId,
      channel: input.channel,
      processedAt: FieldValue.serverTimestamp(),
      // TTL field. The policy is configured on the collection in the console; without
      // it this row is retained forever and the ledger grows without bound.
      expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86_400_000),
    };
    // create(), not set(): if a concurrent run already claimed this message the whole
    // batch aborts and the document is never written, so two pollers overlapping
    // produce one document rather than two.
    batch.create(ledgerRef, ledger);
  }

  try {
    await batch.commit();
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    if (code === 6 || code === 'already-exists') {
      const existing = ledgerRef ? await ledgerRef.get() : null;
      const claimed = existing?.exists ? (existing.data() as ProcessedMessageDoc).docId : docId;
      logger.debug('ingest: message already claimed by a concurrent run', { ledgerKey });
      return { status: 'already_ingested', docId: claimed };
    }
    throw err;
  }

  try {
    await bucket().file(storagePath).save(input.bytes, {
      contentType: input.contentType,
      // Never inline. A mislabelled SVG or HTML served from the bucket is stored XSS
      // aimed at whoever opens it, and mail attachments are the least trustworthy
      // bytes in the system.
      metadata: { contentDisposition: 'attachment' },
      resumable: false,
    });
  } catch (err: unknown) {
    // Roll back BOTH, or the poller will skip this message forever on the strength of
    // a ledger entry whose document has no bytes behind it.
    logger.error('ingest: upload failed, rolling back', {
      docId,
      storagePath,
      err: String(err),
    });
    await Promise.allSettled([docRef.delete(), ledgerRef?.delete()]);
    throw err;
  }

  logger.info('ingest: document created', {
    docId,
    channel: input.channel,
    clientId: input.clientId,
    method: input.clientMatch.method,
    bytes: input.bytes.length,
  });

  return { status: 'ingested', docId };
}
