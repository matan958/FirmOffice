import convert from 'heic-convert';
import { logger } from 'firebase-functions';
import { bucket } from '../lib/firebase.js';
import { STORAGE_PREFIX } from '../shared.js';

/**
 * HEIC → JPEG on ingest (OPEN ITEM #2, decided: convert).
 *
 * Two reasons, not one. Cloud Vision cannot read HEIC — but neither can any browser,
 * so without this the accountant's preview would be blank even if OCR were skipped.
 * Converting fixes reading and viewing at once.
 *
 * `heic-convert` is pure JavaScript. `sharp` would be faster but needs libheif as a
 * native dependency, which complicates the Functions runtime for a format that arrives
 * a few times a day.
 *
 * The output goes to a SEPARATE prefix. Writing back into incoming/ would re-fire the
 * ingest trigger on this function's own output — the classic storage-trigger loop. The
 * original HEIC is left in place: for a CPA firm, destroying the file the client
 * actually sent is not a trade worth making for a little storage.
 */

/** Replaces the extension, preserving the rest of the (already sanitized) name. */
export function jpegNameFor(fileName: string): string {
  return `${fileName.replace(/\.[^./]*$/, '')}.jpg`;
}

export function convertedPath(docId: string, fileName: string): string {
  return `${STORAGE_PREFIX.converted}/${docId}/${jpegNameFor(fileName)}`;
}

export interface ConversionResult {
  storagePath: string;
  contentType: 'image/jpeg';
  sizeBytes: number;
}

/**
 * Reads the HEIC at `srcPath`, writes a JPEG beside it under converted/, and returns
 * the new file metadata. Throws if the bytes are not decodable — the caller turns that
 * into a CONVERSION_FAILED rejection rather than a silent skip.
 */
export async function convertHeicToJpeg(
  srcPath: string,
  docId: string,
  fileName: string,
): Promise<ConversionResult> {
  const [input] = await bucket().file(srcPath).download();

  const output = await convert({
    // download() yields a Buffer, which is already a Uint8Array — no cast needed.
    buffer: input,
    format: 'JPEG',
    // High enough that OCR is not fighting compression artefacts; low enough that a
    // 12-megapixel phone photo does not balloon past Vision's 20 MB image limit.
    quality: 0.92,
  });

  const jpeg = Buffer.from(output);
  const destPath = convertedPath(docId, fileName);

  await bucket().file(destPath).save(jpeg, {
    contentType: 'image/jpeg',
    // Never inline: the bucket must not be a vector for serving content at a browser.
    metadata: { contentDisposition: 'attachment' },
  });

  logger.info('heic converted', {
    docId,
    srcPath,
    destPath,
    fromBytes: input.length,
    toBytes: jpeg.length,
  });

  return { storagePath: destPath, contentType: 'image/jpeg', sizeBytes: jpeg.length };
}
