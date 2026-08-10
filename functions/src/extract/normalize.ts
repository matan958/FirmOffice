import { AMOUNT_RECONCILE_TOLERANCE, DEFAULT_CURRENCY } from '../shared.js';
import type { ExtractedFields } from '../shared.js';

/**
 * Cleans and sanity-checks whatever the model returned.
 *
 * A schema-constrained response guarantees the SHAPE, not the CONTENT. The model can
 * still return `"₪248.98"` in a string field, a two-digit year, a tax ID with dashes,
 * or an amount it quietly computed instead of read. Everything here is deterministic
 * and pure, so the parts most likely to be wrong are the parts that cost nothing to
 * test.
 */

/** Strips currency symbols, spaces and thousands separators; keeps the decimal point. */
export function toAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? round2(value) : null;
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[₪$€£]/g, '')
    .replace(/ש"ח|שח|ILS|NIS|USD|EUR/gi, '')
    .replace(/[\s ,]/g, '')
    .trim();

  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? round2(n) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Normalizes a date to ISO yyyy-mm-dd.
 *
 * Israeli documents are DAY-FIRST. The prompt says so and the model generally obeys,
 * but this is the one field where a plausible wrong answer is invisible: 03/12/2026
 * read as 3 December instead of 12 March lands the document in the wrong VAT period,
 * and nothing about the value looks wrong afterwards. So an ambiguous slashed date is
 * re-parsed here day-first rather than trusted.
 */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;

  // Already ISO — the requested format, and unambiguous.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slashed = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (slashed) {
    const day = Number(slashed[1]);
    const month = Number(slashed[2]);
    let year = Number(slashed[3]);
    // A two-digit year on a tax document is this century — these are not 1926 receipts.
    if (year < 100) year += 2000;
    return validDate(year, month, day);
  }

  return null;
}

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1990 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February, which would otherwise roll silently into March.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Israeli company and dealer numbers are 9 digits; strip anything else. */
export function toTaxId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 9 ? digits : null;
}

export function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  // The model sometimes answers the question rather than declining it.
  if (trimmed === '' || /^(null|n\/a|none|לא נמצא|לא ידוע)$/i.test(trimmed)) return null;
  return trimmed.slice(0, 200);
}

export interface Normalized {
  fields: ExtractedFields;
  /** True when all three amounts are present and net + VAT ≠ total. */
  amountsMismatch: boolean;
}

export function normalize(raw: Record<string, unknown>): Normalized {
  const netAmount = toAmount(raw['netAmount']);
  const vatAmount = toAmount(raw['vatAmount']);
  const totalAmount = toAmount(raw['totalAmount']);

  const fields: ExtractedFields = {
    documentType: toText(raw['documentType']),
    invoiceNumber: toText(raw['invoiceNumber']),
    issueDate: toIsoDate(raw['issueDate']),
    vendorName: toText(raw['vendorName']),
    vendorTaxId: toTaxId(raw['vendorTaxId']),
    netAmount,
    vatAmount,
    totalAmount,
    currency: toText(raw['currency'])?.toUpperCase() ?? DEFAULT_CURRENCY,
  };

  return { fields, amountsMismatch: amountsDisagree(netAmount, vatAmount, totalAmount) };
}

/**
 * Whether the three amounts fail to add up.
 *
 * Only meaningful when all three were found — two out of three cannot disagree, and
 * flagging a document merely because a field is blank would make the warning
 * meaningless within a week.
 */
export function amountsDisagree(
  net: number | null,
  vat: number | null,
  total: number | null,
): boolean {
  if (net === null || vat === null || total === null) return false;
  return Math.abs(net + vat - total) > AMOUNT_RECONCILE_TOLERANCE;
}
