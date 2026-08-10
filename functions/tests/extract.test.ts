import { describe, expect, it } from 'vitest';
import {
  amountsDisagree,
  normalize,
  toAmount,
  toIsoDate,
  toTaxId,
  toText,
} from '../src/extract/normalize.js';
import { buildPrompt, responseSchema } from '../src/extract/schema.js';
import { ALL_EXTRACTED_FIELDS } from '../src/shared.js';

/**
 * A schema-constrained model response guarantees the SHAPE, not the CONTENT. These
 * cover what the model still gets to be wrong about — and the date handling in
 * particular, where a plausible wrong answer is invisible afterwards.
 */

describe('toAmount', () => {
  it('accepts plain numbers', () => {
    expect(toAmount(248.98)).toBe(248.98);
    expect(toAmount(0)).toBe(0);
  });

  it('strips currency symbols and separators the model was told not to send', () => {
    expect(toAmount('₪248.98')).toBe(248.98);
    expect(toAmount('1,234.56')).toBe(1234.56);
    expect(toAmount('248.98 ש"ח')).toBe(248.98);
    // U+00A0. Hebrew text pasted through OCR is full of them and they are invisible.
    expect(toAmount('1 234.56')).toBe(1234.56);
  });

  it('rejects rather than guesses', () => {
    expect(toAmount('לא נמצא')).toBeNull();
    expect(toAmount('')).toBeNull();
    expect(toAmount(null)).toBeNull();
    expect(toAmount('12.34.56')).toBeNull();
    expect(toAmount(Number.NaN)).toBeNull();
  });

  it('distinguishes a missing amount from zero', () => {
    // Collapsing these would have an accountant post a nil entry for a real invoice.
    expect(toAmount(0)).toBe(0);
    expect(toAmount(undefined)).toBeNull();
  });
});

describe('toIsoDate', () => {
  it('passes ISO through', () => {
    expect(toIsoDate('2026-03-12')).toBe('2026-03-12');
  });

  it('reads slashed dates DAY-FIRST, as Israeli documents are written', () => {
    // The whole reason this function exists. 03/12/2026 read as 3 December instead of
    // 12 March files the document in the wrong VAT period, and nothing about the
    // stored value looks wrong afterwards.
    expect(toIsoDate('12/03/2026')).toBe('2026-03-12');
    expect(toIsoDate('03/12/2026')).toBe('2026-12-03');
    expect(toIsoDate('1.4.2026')).toBe('2026-04-01');
    expect(toIsoDate('31-01-2026')).toBe('2026-01-31');
  });

  it('expands a two-digit year into this century', () => {
    expect(toIsoDate('12/03/26')).toBe('2026-03-12');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    // new Date(2026, 1, 31) silently becomes 3 March.
    expect(toIsoDate('31/02/2026')).toBeNull();
    expect(toIsoDate('12/13/2026')).toBeNull();
    expect(toIsoDate('00/01/2026')).toBeNull();
    expect(toIsoDate('not a date')).toBeNull();
    expect(toIsoDate('')).toBeNull();
  });
});

describe('toTaxId', () => {
  it('keeps digits only', () => {
    expect(toTaxId('514366954')).toBe('514366954');
    expect(toTaxId('ח.פ. 514366954')).toBe('514366954');
    expect(toTaxId('51-436695-4')).toBe('514366954');
  });

  it('rejects anything not the right length', () => {
    expect(toTaxId('123')).toBeNull();
    expect(toTaxId('12345678901234')).toBeNull();
    expect(toTaxId('')).toBeNull();
  });

  it('pads a dropped leading zero to nine digits', () => {
    // This function became a JOIN KEY when it started deciding income vs expense:
    // the same number is normalized from the client record and from the scan, and the
    // two are compared for equality. Left unpadded, an eight-digit read of a nine-digit
    // number is a different string, and the comparison misses with nothing to show for
    // it — which looks exactly like "the classifier doesn't work".
    expect(toTaxId('012345678')).toBe('012345678');
    expect(toTaxId('12345678')).toBe('012345678');
    expect(toTaxId('12345678')).toBe(toTaxId('012345678'));
  });
});

describe('toText', () => {
  it('collapses whitespace and preserves Hebrew', () => {
    expect(toText('  חשבונית   מס  ')).toBe('חשבונית מס');
    expect(toText('סופר פארם בע"מ')).toBe('סופר פארם בע"מ');
  });

  it('treats the model answering instead of declining as a decline', () => {
    expect(toText('N/A')).toBeNull();
    expect(toText('לא נמצא')).toBeNull();
    expect(toText('null')).toBeNull();
    expect(toText('   ')).toBeNull();
  });
});

describe('amountsDisagree', () => {
  it('accepts amounts that add up', () => {
    expect(amountsDisagree(211, 37.98, 248.98)).toBe(false);
  });

  it('tolerates rounding of a couple of agorot', () => {
    expect(amountsDisagree(211, 37.98, 248.99)).toBe(false);
  });

  it('flags a misread digit', () => {
    // The single most useful automatic check on a tax document: a digit wrong
    // anywhere in the three makes the sum fail, without anyone re-reading the scan.
    expect(amountsDisagree(211, 37.98, 348.98)).toBe(true);
    expect(amountsDisagree(211, 3.79, 248.98)).toBe(true);
  });

  it('stays silent when a field is missing', () => {
    // Two out of three cannot disagree, and warning on every incomplete document
    // would make the flag meaningless within a week.
    expect(amountsDisagree(null, 37.98, 248.98)).toBe(false);
    expect(amountsDisagree(211, null, 248.98)).toBe(false);
    expect(amountsDisagree(211, 37.98, null)).toBe(false);
  });

  it('is independent of the VAT rate', () => {
    // Israeli VAT moved from 17% to 18% in January 2025. A rate check would mis-flag
    // every older document; the addition holds whatever the rate.
    expect(amountsDisagree(100, 17, 117)).toBe(false);
    expect(amountsDisagree(100, 18, 118)).toBe(false);
  });
});

describe('normalize', () => {
  it('handles the response shape the live endpoint actually returned', () => {
    const { fields, amountsMismatch } = normalize({
      documentType: 'חשבונית מס / קבלה',
      invoiceNumber: '2024-00187',
      issueDate: '2026-03-12',
      vendorName: 'סופר פארם בע"מ',
      vendorTaxId: '514366954',
      netAmount: 211,
      vatAmount: 37.98,
      totalAmount: 248.98,
      currency: 'ILS',
    });

    expect(fields).toEqual({
      documentType: 'חשבונית מס / קבלה',
      invoiceNumber: '2024-00187',
      issueDate: '2026-03-12',
      vendorName: 'סופר פארם בע"מ',
      vendorTaxId: '514366954',
      recipientName: null,
      recipientTaxId: null,
      netAmount: 211,
      vatAmount: 37.98,
      totalAmount: 248.98,
      currency: 'ILS',
    });
    expect(amountsMismatch).toBe(false);
  });

  it('carries the counterparty through', () => {
    // These must survive normalize(): runExtraction writes `extracted` as a whole-object
    // replace, so a key normalize() does not emit is erased on the next OCR retry —
    // silently taking the income/expense decision with it.
    const { fields } = normalize({
      vendorTaxId: 'ח.פ. 513094219',
      recipientName: '  טסט קליינט   בע"מ ',
      recipientTaxId: '51-566700-1',
    });

    expect(fields.recipientName).toBe('טסט קליינט בע"מ');
    expect(fields.recipientTaxId).toBe('515667001');
    expect(fields.vendorTaxId).toBe('513094219');
  });

  it('defaults an absent currency to shekels', () => {
    expect(normalize({}).fields.currency).toBe('ILS');
  });

  it('turns every unfound field into null, never undefined', () => {
    const { fields } = normalize({});
    for (const field of ALL_EXTRACTED_FIELDS) {
      expect(fields[field.key]).toBeNull();
    }
  });
});

describe('schema generation', () => {
  it('asks for exactly the fields the panel renders', () => {
    // Generated from EXTRACTION_FIELDS so the two cannot drift. Hand-written, the
    // failure is silent: a field added to the panel and forgotten in the prompt is
    // blank forever, with no error anywhere.
    const schema = responseSchema() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const field of ALL_EXTRACTED_FIELDS) {
      expect(schema.properties[field.key]).toBeDefined();
      expect(schema.required).toContain(field.key);
    }
    expect(schema.required).toContain('currency');
  });

  it('types money as a number and everything else as a string', () => {
    const { properties } = responseSchema() as { properties: Record<string, { type: string }> };
    expect(properties['totalAmount']?.type).toBe('NUMBER');
    expect(properties['invoiceNumber']?.type).toBe('STRING');
    // An identifier with leading zeros must not become a number and lose them.
    expect(properties['vendorTaxId']?.type).toBe('STRING');
  });

  it('requires every field AND allows null, so "not found" is a stated answer', () => {
    const { properties, required } = responseSchema() as {
      properties: Record<string, { nullable?: boolean }>;
      required: string[];
    };
    for (const key of required) {
      expect(properties[key]?.nullable).toBe(true);
    }
  });

  it('puts every field label and hint into the prompt', () => {
    const prompt = buildPrompt('some OCR text');
    for (const field of ALL_EXTRACTED_FIELDS) {
      expect(prompt).toContain(field.key);
      expect(prompt).toContain(field.label);
    }
    expect(prompt).toContain('some OCR text');
  });
});
