import { createHash } from 'node:crypto';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { logger } from 'firebase-functions';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { fileTypeFromBuffer } from 'file-type';
import { bucket, db } from '../lib/firebase.js';
import { classify, parseIncomingPath } from './classify.js';
import { convertHeicToJpeg } from './convertHeic.js';
import { enqueueOcr } from '../ocr/enqueue.js';
import {
  COLLECTIONS,
  DUPLICATE_WINDOW_DAYS,
  MAX_FILE_BYTES,
  STORAGE_PREFIX,
} from '../shared.js';
import type { DocumentDoc, ErrorCode, PipelineStatus } from '../shared.js';

/**
 * Ingest trigger: fires when bytes land under incoming/.
 *
 * Everything here is about not trusting the uploader. The browser-supplied MIME type
 * comes from the file extension and is trivially forged, so the real type is sniffed
 * from magic bytes and the stored Content-Type is corrected to match. A `.jpg` that is
 * really an HTML document would otherwise sit in the bucket waiting to be served
 * inline at an accountant.
 *
 * The hash is computed here rather than in the browser for the same reason: a
 * duplicate check the client can lie to is not worth running.
 *
 * Storage triggers are at-least-once, so this must be idempotent — it bails if the
 * document has already moved past `uploading`.
 */

/** Enough for every signature file-type knows about. */
const SNIFF_BYTES = 4100;

/** Streams the object once: hashes every byte, keeps the head for sniffing. */
async function readHashAndHead(
  path: string,
): Promise<{ sha256: string; head: Buffer; bytes: number }> {
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let headLen = 0;
  let bytes = 0;

  await new Promise<void>((resolve, reject) => {
    bucket()
      .file(path)
      .createReadStream()
      .on('data', (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
        if (headLen < SNIFF_BYTES) {
          chunks.push(chunk.subarray(0, SNIFF_BYTES - headLen));
          headLen += Math.min(chunk.length, SNIFF_BYTES - headLen);
        }
      })
      .on('error', reject)
      .on('end', resolve);
  });

  return { sha256: hash.digest('hex'), head: Buffer.concat(chunks), bytes };
}

/**
 * Finds an earlier document from the same client with identical bytes.
 *
 * Same hash + same client inside the window is a re-send — clients genuinely mail an
 * invoice and then WhatsApp the same one. The copy is kept (it may carry a different
 * caption or context) and merely flagged, so the inbox can collapse it rather than
 * silently discarding something a client believes they sent.
 *
 * The clientId comes from the DOCUMENT, not from the storage path. Those agree for a
 * web upload but not for an unassigned Gmail document, whose path segment is the
 * literal `_unassigned` while its `clientId` field is null — querying on the path
 * value would match nothing at all and quietly disable de-duplication for exactly the
 * channel that produces the most duplicates.
 */
async function findDuplicate(
  clientId: string,
  sha256: string,
  selfDocId: string,
): Promise<string | null> {
  const cutoff = Timestamp.fromMillis(Date.now() - DUPLICATE_WINDOW_DAYS * 86_400_000);
  const snap = await db()
    .collection(COLLECTIONS.documents)
    .where('clientId', '==', clientId)
    .where('file.sha256', '==', sha256)
    .where('createdAt', '>=', cutoff)
    .limit(2)
    .get();

  const hit = snap.docs.find((d) => d.id !== selfDocId);
  return hit?.id ?? null;
}

async function quarantine(srcPath: string, docId: string, fileName: string): Promise<void> {
  const dest = `${STORAGE_PREFIX.quarantine}/${docId}/${fileName}`;
  await bucket()
    .file(srcPath)
    .move(dest)
    .catch((err: unknown) => {
      // A failed move must not fail the whole trigger — the document is already marked
      // rejected, and a lifecycle rule sweeps the incoming copy either way.
      logger.warn('quarantine move failed', { srcPath, dest, err: String(err) });
    });
}

export const onDocumentUploaded = onObjectFinalized(
  {
    // Scoping the trigger keeps thumbnails/ and ocr-output/ writes from re-entering it.
    // Gen 2 has no server-side prefix filter, so the guard below is the real one.
    memory: '512MiB',
    timeoutSeconds: 300,
  },
  async (event) => {
    const objectPath = event.data.name;
    const parsed = parseIncomingPath(objectPath);
    if (!parsed) return; // Not an incoming upload — thumbnails, OCR output, etc.

    const { docId, fileName } = parsed;
    const docRef = db().doc(`${COLLECTIONS.documents}/${docId}`);
    const snap = await docRef.get();

    if (!snap.exists) {
      // Bytes with no record. Cannot be filed against a client, so quarantine rather
      // than leave it sitting in an ingest prefix forever.
      logger.warn('upload with no document record', { objectPath, docId });
      await quarantine(objectPath, docId, fileName);
      return;
    }

    const current = snap.data() as DocumentDoc;

    // At-least-once delivery: a retry of an already-processed object must not redo the
    // work or clobber a later stage's results.
    if (current.pipelineStatus !== 'uploading') {
      logger.debug('ingest: already processed', { docId, status: current.pipelineStatus });
      return;
    }

    const fail = async (code: ErrorCode, message: string) => {
      await docRef.update({
        pipelineStatus: 'rejected' satisfies PipelineStatus,
        error: { code, message, stage: 'validate', attempts: 1, lastAttemptAt: FieldValue.serverTimestamp() },
        updatedAt: FieldValue.serverTimestamp(),
      });
      await quarantine(objectPath, docId, fileName);
      logger.warn('ingest rejected', { docId, code, message });
    };

    try {
      const { sha256, head, bytes } = await readHashAndHead(objectPath);

      if (bytes === 0) {
        await fail('FILE_EMPTY', 'The file is empty.');
        return;
      }
      if (bytes > MAX_FILE_BYTES) {
        // storage.rules caps this too, but rules are not the only write path.
        await fail('FILE_TOO_LARGE', `File is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}.`);
        return;
      }

      // The authoritative type. Note file-type cannot identify CSV or plain text —
      // they have no magic bytes — so those fall back to the declared type below.
      const sniffed = await fileTypeFromBuffer(head);
      const declared = current.file.contentType;
      const contentType = sniffed?.mime ?? declared;

      const disposition = classify(contentType);
      if (disposition === 'reject') {
        await fail('UNSUPPORTED_TYPE', `${contentType} is not an accepted file type.`);
        return;
      }

      // Correct the stored Content-Type to the sniffed one, and never let the bucket
      // serve anything inline — a mislabelled SVG or HTML is a stored-XSS vector
      // pointed at whoever opens it.
      if (sniffed && sniffed.mime !== declared) {
        logger.info('ingest: content type corrected', { docId, declared, sniffed: sniffed.mime });
      }
      await bucket()
        .file(objectPath)
        .setMetadata({ contentType, contentDisposition: 'attachment' })
        .catch((err: unknown) => logger.warn('setMetadata failed', { docId, err: String(err) }));

      // Unassigned documents are not compared: everything sitting in the Unassigned
      // queue would otherwise be "the same client" as everything else there.
      const duplicateOf = current.clientId
        ? await findDuplicate(current.clientId, sha256, docId)
        : null;

      // HEIC is converted to JPEG here rather than rejected: Vision cannot read it and
      // neither can any browser, so converting fixes both OCR and the preview. The
      // output lands under converted/, which parseIncomingPath ignores — writing back
      // into incoming/ would re-fire this trigger on its own output.
      let storagePath = objectPath;
      let finalType = contentType;
      let finalBytes = bytes;

      if (disposition === 'needs_conversion') {
        try {
          const converted = await convertHeicToJpeg(objectPath, docId, fileName);
          storagePath = converted.storagePath;
          finalType = converted.contentType;
          finalBytes = converted.sizeBytes;
        } catch (err: unknown) {
          await fail('CONVERSION_FAILED', `Could not convert HEIC image: ${String(err)}`);
          return;
        }
      }

      const willOcr = classify(finalType) === 'ocr';
      const next: PipelineStatus = willOcr ? 'ocr_queued' : 'skipped_ocr';

      // Dotted paths so the client-written file.originalName survives — a nested
      // object would replace the whole map. Not expressible in the model type, which
      // describes documents as they are read.
      await docRef.update({
        'file.sha256': sha256,
        'file.contentType': finalType,
        'file.sizeBytes': finalBytes,
        'file.storagePath': storagePath,
        pipelineStatus: next,
        duplicateOf,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Enqueue AFTER the document update, so the task cannot start before the record
      // says ocr_queued — the handler's idempotency guard reads that status.
      if (willOcr) await enqueueOcr(docId);

      logger.info('ingest ok', {
        docId,
        contentType: finalType,
        bytes: finalBytes,
        next,
        duplicateOf,
        converted: storagePath !== objectPath,
      });
    } catch (err: unknown) {
      logger.error('ingest failed', { docId, err: String(err) });
      await docRef
        .update({
          pipelineStatus: 'rejected' satisfies PipelineStatus,
          error: {
            code: 'INTERNAL' satisfies ErrorCode,
            message: String(err),
            stage: 'ingest',
            attempts: 1,
            lastAttemptAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => undefined);
    }
  },
);
