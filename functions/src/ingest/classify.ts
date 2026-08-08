import {
  NEEDS_CONVERSION_MIME,
  OCR_SUPPORTED_MIME,
  STORAGE_PREFIX,
  STORE_ONLY_MIME,
} from '../shared.js';

/**
 * Pure ingest helpers, deliberately free of any firebase-admin or firebase-functions
 * import so they can be unit-tested without a runtime or an emulator.
 */

export interface IncomingPath {
  clientId: string;
  docId: string;
  fileName: string;
}

/**
 * Parses `incoming/{clientId}/{docId}/{fileName}`.
 *
 * Returns null for anything else — the Gen 2 storage trigger fires for EVERY object in
 * the bucket, including thumbnails and OCR output this function itself causes to be
 * written. Getting this wrong means either dropping real uploads or an infinite
 * trigger loop.
 *
 * The filename may itself contain slashes; everything after the docId is rejoined.
 */
export function parseIncomingPath(name: string): IncomingPath | null {
  const parts = name.split('/');
  if (parts.length < 4) return null;

  const [prefix, clientId, docId, ...rest] = parts;
  if (prefix !== STORAGE_PREFIX.incoming) return null;
  if (!clientId || !docId || rest.length === 0) return null;

  const fileName = rest.join('/');
  if (!fileName) return null;

  return { clientId, docId, fileName };
}

export type Disposition = 'ocr' | 'store_only' | 'needs_conversion' | 'reject';

/**
 * What to do with a file of this (sniffed) type.
 *
 * An .xlsx bank statement is a document the firm needs even though nothing can OCR it,
 * so store-only types are accepted rather than rejected. HEIC is accepted for the same
 * reason — Vision cannot read it, but silently dropping every iPhone photo would look
 * like ingestion is broken.
 */
export function classify(contentType: string): Disposition {
  if ((OCR_SUPPORTED_MIME as readonly string[]).includes(contentType)) return 'ocr';
  if ((STORE_ONLY_MIME as readonly string[]).includes(contentType)) return 'store_only';
  if ((NEEDS_CONVERSION_MIME as readonly string[]).includes(contentType)) return 'needs_conversion';
  return 'reject';
}
