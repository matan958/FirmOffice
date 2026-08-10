import {
  DIRECTION_CONFIDENCE,
  NON_TAX_DOCUMENT_RE,
  normalizeBusinessName,
  toTaxId,
} from '../shared.js';
import type { ClassificationRule, DocDirection, ExtractedFields } from '../shared.js';

/**
 * Decides whether a document is income or an expense FOR A PARTICULAR CLIENT.
 *
 * The direction is not a property of the document. The very same invoice is income to
 * the business that issued it and an expense to the business that received it, so the
 * question can only be answered against a client record — which is why this is derived
 * in code rather than asked of the model, and why it is stored outside `extracted`.
 *
 * Two consequences worth stating, because they are the reason for this design:
 *
 *  - It EXPLAINS itself. Every answer names the rung that produced it and carries a
 *    Hebrew sentence an accountant can check against the scan beside it. A direction
 *    puts VAT into either מע"מ עסקאות or מע"מ תשומות, so "trust me" is not good enough.
 *
 *  - It is FREE to re-run. No network call, no model, no cost — so when a client's ח.פ.
 *    is entered weeks after their first documents were read, the whole back catalogue
 *    can be re-decided from what is already stored.
 *
 * Pure and fully injected, like mapping/resolveClient.ts. The ordering of the rungs is
 * the entire substance of the file, and it is only testable if nothing here does I/O.
 */

export interface DirectionInput {
  /** The client's own ח.פ., normalized. Null when nobody has entered it yet. */
  clientTaxId: string | null;
  clientName: string | null;
  clientLegalName: string | null;
  fields: ExtractedFields;
}

export interface DirectionDecision {
  direction: DocDirection;
  confidence: number;
  /** Hebrew, rendered verbatim in the panel. */
  reason: string;
  rule: ClassificationRule;
}

function decision(rule: Exclude<ClassificationRule, 'manual'>, direction: DocDirection, reason: string): DirectionDecision {
  return { rule, direction, reason, confidence: DIRECTION_CONFIDENCE[rule] };
}

/** True when `name` is the client under any of the spellings we hold for them. */
function isClientName(name: string | null, input: DirectionInput): boolean {
  if (!name) return false;
  const candidate = normalizeBusinessName(name);
  if (candidate === '') return false;

  for (const known of [input.clientName, input.clientLegalName]) {
    if (known && normalizeBusinessName(known) === candidate) return true;
  }
  return false;
}

export function decideDirection(input: DirectionInput): DirectionDecision {
  const f = input.fields;

  // Normalized on the way in rather than trusted. `extracted` is written by the model
  // through normalize(), but it is also writable by hand from the panel, and a human
  // typing "51-436695-4" must land on the same string as OCR reading "514366954".
  const clientTaxId = toTaxId(input.clientTaxId);
  const issuerTaxId = toTaxId(f.vendorTaxId);
  const recipientTaxId = toTaxId(f.recipientTaxId);

  // ── 1. Not a bookkeeping document at all ──────────────────────────────────
  // First, because it is decisive regardless of who the parties are. A חשבון עסקה
  // carries amounts and VAT and looks exactly like an invoice; booking one is a real
  // filing error, not a mislabelled row.
  if (f.documentType && NON_TAX_DOCUMENT_RE.test(f.documentType)) {
    return decision('nonTaxDocument', 'neither', 'מסמך שאינו חשבונית מס — אינו נכנס לספרים');
  }

  // ── 2. Both sides are the client ──────────────────────────────────────────
  // MUST precede rungs 3 and 4: checked after them it could never fire, and the
  // document would be silently called income on the strength of half the evidence.
  // Means a misread digit or a self-billing document — either way, a human decides.
  if (clientTaxId && issuerTaxId === clientTaxId && recipientTaxId === clientTaxId) {
    return decision('ambiguous', 'unknown', 'ח.פ. של הלקוח מופיע בשני הצדדים — נדרשת בדיקה');
  }

  // ── 3–4. The ח.פ. answer. This is the rung the whole feature exists for. ───
  if (clientTaxId && issuerTaxId === clientTaxId) {
    return decision('issuerTaxId', 'income', 'ח.פ. של הלקוח מופיע בצד המנפיק');
  }
  if (clientTaxId && recipientTaxId === clientTaxId) {
    return decision('recipientTaxId', 'expense', 'ח.פ. של הלקוח מופיע בצד המקבל');
  }

  // ── 5–6. Name fallback ────────────────────────────────────────────────────
  // MUST precede rung 7, even though 7 scores higher. Rung 7 reasons from the ABSENCE
  // of a named customer; these reason from POSITIVE evidence that the client is one of
  // the parties. A name match means the ח.פ. was misread, not that the document belongs
  // to somebody else, and evidence outranks absence whatever the numbers say.
  if (isClientName(f.vendorName ?? null, input)) {
    return decision('issuerName', 'income', 'שם הלקוח מופיע בצד המנפיק (ללא התאמת ח.פ.)');
  }
  if (isClientName(f.recipientName ?? null, input)) {
    return decision('recipientName', 'expense', 'שם הלקוח מופיע בצד המקבל (ללא התאמת ח.פ.)');
  }

  // Everything below compares the document against the client's ח.פ., so without one
  // there is nothing to compare and "not equal" would be trivially true. Falling
  // through here instead of guarding would call every document an expense on the
  // strength of a check that never ran.
  if (!clientTaxId) {
    return decision(
      'clientTaxIdMissing',
      'unknown',
      'לא הוזן ח.פ. ללקוח במערכת — לא ניתן לקבוע הכנסה או הוצאה',
    );
  }

  if (issuerTaxId && issuerTaxId !== clientTaxId) {
    // ── 7. Issued by someone else, addressed to nobody ──────────────────────
    // The workhorse. Petrol, parking, supermarket: a retail receipt names no customer,
    // so no other rung can catch it, and these are most of what a small business files.
    if (!recipientTaxId && !f.recipientName) {
      return decision('noRecipient', 'expense', 'המסמך הונפק על ידי עסק אחר ואינו נושא שם לקוח');
    }

    // ── 8. Addressed to a different business ────────────────────────────────
    // A stated ח.פ. that is not the client's is real evidence against this document
    // belonging in their books — most likely it was filed under the wrong client.
    if (recipientTaxId) {
      return decision(
        'neitherParty',
        'unknown',
        'אף אחד מהצדדים אינו הלקוח — ייתכן שהמסמך שויך ללקוח הלא נכון',
      );
    }

    // ── 9. Named customer we could not match ────────────────────────────────
    // Only a name, and it did not match. Far weaker than rung 8: the client's name is
    // routinely printed in a different spelling from the one on their record. Expense
    // is the right prior for a document in their file that they did not issue, but
    // deliberately scored below the review threshold so it is checked, not trusted.
    return decision(
      'unverifiedRecipient',
      'expense',
      'המסמך הונפק על ידי עסק אחר, אך שם הלקוח במסמך אינו תואם',
    );
  }

  // ── 10. Nothing to go on ──────────────────────────────────────────────────
  return decision('insufficient', 'unknown', 'לא נמצאו במסמך פרטי זיהוי מספיקים');
}
