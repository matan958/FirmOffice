import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { extractWithGemini } from './gemini.js';
import { normalize } from './normalize.js';
import { COLLECTIONS } from '../shared.js';
import type { DocumentDoc, ExtractedFields, ExtractionMeta } from '../shared.js';

/**
 * Reads the structured fields off a document's OCR text and stores them.
 *
 * ── Two rules this follows ──
 *
 * **It never fails the pipeline.** The text is the valuable thing; the fields are a
 * convenience on top. If Gemini is down, over quota, or returns nonsense, the document
 * still shows its scan and its text and still sits in the accountant's queue — the
 * failure is recorded on the document and nothing else changes. Extraction is
 * therefore called in its own try/catch by the OCR task, not chained to it.
 *
 * **It never overwrites a human.** Once an accountant has corrected a field, that
 * field is theirs. A re-run — from Retry OCR, or a future re-extract — fills in the
 * blanks around it and leaves it alone. Anything else would quietly undo the exact
 * work that makes the feature trustworthy.
 */

/** Below this there is nothing to extract from, and a call would be paid for nothing. */
const MIN_TEXT_CHARS = 20;

export async function runExtraction(docId: string): Promise<'done' | 'skipped' | 'failed'> {
  const startedAt = Date.now();
  const docRef = db().collection(COLLECTIONS.documents).doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) return 'skipped';

  const doc = snap.data() as DocumentDoc;

  const text = doc.ocr?.fullText ?? doc.ocr?.preview ?? '';
  if (text.trim().length < MIN_TEXT_CHARS) {
    logger.debug('extract: not enough text', { docId, chars: text.trim().length });
    return 'skipped';
  }

  const corrected = new Set(doc.extraction?.correctedFields ?? []);

  try {
    const { raw, model } = await extractWithGemini(text);
    const { fields, amountsMismatch } = normalize(raw);

    // Hand-corrected fields win. Applied here rather than in the write so the
    // mismatch flag below is computed against what will actually be stored.
    const merged: ExtractedFields = { ...fields };
    for (const key of corrected) {
      const existing = (doc.extracted ?? {})[key as keyof ExtractedFields];
      if (existing !== undefined) {
        (merged as Record<string, unknown>)[key] = existing;
      }
    }

    const meta: Omit<ExtractionMeta, 'extractedAt'> & { extractedAt: FirebaseFirestore.FieldValue } =
      {
        engine: 'gemini',
        model,
        extractedAt: FieldValue.serverTimestamp(),
        durationMs: Date.now() - startedAt,
        amountsMismatch,
        correctedFields: [...corrected],
        error: null,
      };

    await docRef.update({
      extracted: merged,
      extraction: meta,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info('extract ok', {
      docId,
      found: Object.values(merged).filter((v) => v !== null && v !== undefined).length,
      amountsMismatch,
      durationMs: meta.durationMs,
    });
    return 'done';
  } catch (err: unknown) {
    // Recorded on the document, not thrown. See the note above: a failed extraction
    // must not cost the firm the OCR text it already paid for.
    logger.error('extract failed', { docId, err: String(err) });
    await docRef
      .update({
        extraction: {
          engine: 'gemini',
          model: null,
          extractedAt: FieldValue.serverTimestamp(),
          durationMs: Date.now() - startedAt,
          amountsMismatch: false,
          correctedFields: [...corrected],
          error: String(err).slice(0, 500),
        },
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);
    return 'failed';
  }
}
