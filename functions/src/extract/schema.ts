import { ALL_EXTRACTED_FIELDS } from '../shared.js';

/**
 * Builds the request Vertex AI is sent, from the field lists alone.
 *
 * Generated rather than written out, so the field list cannot drift from the prompt.
 * The failure that would otherwise happen is silent and expensive: someone adds a
 * field to the panel, forgets the prompt, and the column is blank forever with no
 * error anywhere — or removes one and keeps paying to extract it.
 *
 * ALL_EXTRACTED_FIELDS, not EXTRACTION_FIELDS: the counterparty is asked for too, and
 * is simply not given a row. What the model is asked and what the panel shows are
 * different questions, and conflating them is what made the recipient unreadable for
 * as long as it was.
 */

/** Vertex's schema dialect is OpenAPI-ish with SHOUTED type names. */
type SchemaType = 'STRING' | 'NUMBER';

function typeFor(kind: string): SchemaType {
  return kind === 'money' ? 'NUMBER' : 'STRING';
}

export function responseSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const field of ALL_EXTRACTED_FIELDS) {
    properties[field.key] = { type: typeFor(field.kind), nullable: true };
  }
  properties['currency'] = { type: 'STRING', nullable: true };

  return {
    type: 'OBJECT',
    properties,
    // Every key required AND nullable, deliberately. Optional keys let the model omit
    // a field it is unsure about, which is indistinguishable downstream from a field
    // nobody asked for. Requiring an explicit null makes "I looked and it is not
    // there" a stated answer rather than an absence.
    required: [...ALL_EXTRACTED_FIELDS.map((f) => f.key), 'currency'],
  };
}

export function buildPrompt(ocrText: string): string {
  const fieldLines = ALL_EXTRACTED_FIELDS.map(
    (f) => `- ${f.key} (${f.label}): ${f.hint}`,
  ).join('\n');

  return `You are reading OCR text from an Israeli tax document — a חשבונית מס (tax invoice), קבלה (receipt), or חשבונית מס-קבלה.

The text comes from OCR of a photograph or scan, so it may be imperfect: lines out of order, columns interleaved, characters wrong. Hebrew is right-to-left and OCR often reverses or splits it awkwardly.

A document has TWO sides: the business that ISSUED it, and the business it is ADDRESSED TO. Read both, and keep them straight — the issuer's details usually sit at the top or in the letterhead, the recipient's beside לכבוד or לקוח. A retail receipt from a shop or petrol station names no customer at all; when that is the case return null for the recipient rather than repeating the issuer.

Extract these fields:
${fieldLines}
- currency: ISO code. ILS for ₪ or ש"ח, which is the default when no symbol appears at all.

Rules:
- Return null for anything you cannot find. NEVER guess, and never infer one amount by calculating it from the others — a wrong number that looks right is worse here than a blank, because a blank gets checked and a plausible number does not.
- Copy values as printed. Do not translate Hebrew into English, do not reformat identifiers, and do not round amounts.
- Amounts must be plain numbers: no currency symbols, no thousands separators.
- Never put the same business on both sides. If only one party is identifiable, it is the issuer.

OCR TEXT:
${ocrText}`;
}
