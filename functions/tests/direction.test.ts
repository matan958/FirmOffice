import { describe, expect, it } from 'vitest';
import { decideDirection } from '../src/classify/direction.js';
import { DIRECTION_MIN_CONFIDENCE, normalizeBusinessName } from '../src/shared.js';
import type { ExtractedFields } from '../src/shared.js';

/**
 * The direction ladder.
 *
 * The ORDER of the rungs is the whole substance of the thing, and two of the orderings
 * are load-bearing in a way that a casual reading of the file would not reveal — each
 * has a test here named after the mistake it prevents, because a later refactor that
 * "tidies" the sequence would otherwise pass everything else.
 *
 * The stakes are why this is table-driven rather than sampled: a wrong direction does
 * not mislabel a row, it moves a document's VAT between מע"מ עסקאות and מע"מ תשומות on
 * a filing.
 */

const CLIENT = '515667001';
const OTHER = '513094219';

function fields(over: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    documentType: 'חשבונית מס',
    invoiceNumber: '4471',
    issueDate: '2026-03-12',
    vendorName: null,
    vendorTaxId: null,
    recipientName: null,
    recipientTaxId: null,
    netAmount: null,
    vatAmount: null,
    totalAmount: null,
    currency: 'ILS',
    ...over,
  };
}

function decide(over: Partial<ExtractedFields>, client: Partial<{ taxId: string | null; name: string | null; legalName: string | null }> = {}) {
  return decideDirection({
    clientTaxId: client.taxId === undefined ? CLIENT : client.taxId,
    clientName: client.name === undefined ? 'טסט קליינט בע"מ' : client.name,
    clientLegalName: client.legalName === undefined ? null : client.legalName,
    fields: fields(over),
  });
}

describe('the ח.פ. rungs', () => {
  it('calls a document the client issued income', () => {
    const d = decide({ vendorTaxId: CLIENT, recipientTaxId: OTHER });
    expect(d.direction).toBe('income');
    expect(d.rule).toBe('issuerTaxId');
    expect(d.confidence).toBeGreaterThan(DIRECTION_MIN_CONFIDENCE);
  });

  it('calls a document addressed to the client an expense', () => {
    const d = decide({ vendorTaxId: OTHER, recipientTaxId: CLIENT });
    expect(d.direction).toBe('expense');
    expect(d.rule).toBe('recipientTaxId');
  });

  it('matches across formatting, because the two sides are typed by different people', () => {
    // The client record is typed by an accountant; the document is read by OCR.
    const d = decide({ vendorTaxId: OTHER, recipientTaxId: '51-566700-1' });
    expect(d.direction).toBe('expense');
  });

  it('matches when OCR dropped a leading zero', () => {
    const d = decideDirection({
      clientTaxId: '012345678',
      clientName: null,
      clientLegalName: null,
      fields: fields({ vendorTaxId: OTHER, recipientTaxId: '12345678' }),
    });
    expect(d.direction).toBe('expense');
  });
});

describe('rung ordering', () => {
  it('checks both-sides-are-the-client BEFORE either side alone', () => {
    // If `ambiguous` is moved below `issuerTaxId` it can never fire, and a document
    // where a digit was misread becomes confident income on half the evidence. This
    // test exists to fail if someone reorders the ladder by tidiness.
    const d = decide({ vendorTaxId: CLIENT, recipientTaxId: CLIENT });
    expect(d.direction).toBe('unknown');
    expect(d.rule).toBe('ambiguous');
    expect(d.confidence).toBeLessThan(DIRECTION_MIN_CONFIDENCE);
  });

  it('prefers a name match over an inference drawn from a missing customer', () => {
    // Issuer name IS the client, but its ח.פ. was misread. Rung 7 (`noRecipient`) would
    // otherwise fire on "issuer is somebody else, nobody named" and call the client's
    // OWN invoice an expense — the exact inversion this feature exists to avoid.
    const d = decide({ vendorName: 'טסט קליינט בע"מ', vendorTaxId: '999999999' });
    expect(d.direction).toBe('income');
    expect(d.rule).toBe('issuerName');
  });
});

describe('the receipt case, which is most of the volume', () => {
  it('calls a retail receipt naming no customer an expense', () => {
    // Petrol, parking, supermarket. No recipient exists to compare, so no other rung
    // can catch these — and they are the bulk of what a small business files.
    const d = decide({
      vendorName: 'גולדור מ.ש.מ טכנולוגיות בע"מ',
      vendorTaxId: OTHER,
      documentType: 'חשבונית מס קבלה',
    });
    expect(d.direction).toBe('expense');
    expect(d.rule).toBe('noRecipient');
    expect(d.confidence).toBeGreaterThan(DIRECTION_MIN_CONFIDENCE);
  });

  it('flags a document addressed to a different business rather than filing it', () => {
    const d = decide({ vendorTaxId: OTHER, recipientTaxId: '999999999' });
    expect(d.direction).toBe('unknown');
    expect(d.rule).toBe('neitherParty');
  });

  it('leans expense but asks for a check when only the customer NAME fails to match', () => {
    // A client's name is routinely printed in a spelling other than the one on their
    // record, so this is much weaker evidence than an unmatched ח.פ. — expense is the
    // right prior, below the review line on purpose.
    const d = decide({ vendorTaxId: OTHER, recipientName: 'Test Client Limited' });
    expect(d.direction).toBe('expense');
    expect(d.rule).toBe('unverifiedRecipient');
    expect(d.confidence).toBeLessThan(DIRECTION_MIN_CONFIDENCE);
  });
});

describe('documents that are neither', () => {
  it('refuses to book a חשבון עסקה', () => {
    // A proforma carries amounts and VAT and looks exactly like an invoice. Booking one
    // is a filing error, not a mislabelled row — which is the whole reason `neither`
    // exists rather than forcing a two-way choice.
    const d = decide({ documentType: 'חשבון עסקה', vendorTaxId: OTHER });
    expect(d.direction).toBe('neither');
    expect(d.rule).toBe('nonTaxDocument');
  });

  it('recognises a bank statement and a delivery note', () => {
    expect(decide({ documentType: 'דף חשבון' }).direction).toBe('neither');
    expect(decide({ documentType: 'תעודת משלוח' }).direction).toBe('neither');
  });

  it('still books a real tax invoice', () => {
    expect(decide({ documentType: 'חשבונית מס', vendorTaxId: CLIENT }).direction).toBe('income');
    expect(decide({ documentType: 'חשבונית מס-קבלה', vendorTaxId: CLIENT }).direction).toBe(
      'income',
    );
  });
});

describe('when the client record is incomplete', () => {
  it('says so instead of guessing, when no ח.פ. has been entered', () => {
    // THE trap this guard exists for: every rung below compares against the client's
    // ח.פ., so without one `issuerTaxId !== clientTaxId` is trivially true and every
    // document would be called an expense on the strength of a check that never ran.
    const d = decide({ vendorTaxId: OTHER }, { taxId: null, name: null });
    expect(d.direction).toBe('unknown');
    expect(d.rule).toBe('clientTaxIdMissing');
    expect(d.reason).toContain('ח.פ.');
  });

  it('can still decide from the name alone', () => {
    const d = decide({ vendorName: 'טסט קליינט בע"מ' }, { taxId: null });
    expect(d.direction).toBe('income');
    expect(d.rule).toBe('issuerName');
  });

  it('matches a legalName that differs from the display name', () => {
    const d = decide(
      { recipientName: 'טסט קליינט (2019) בעמ', vendorTaxId: OTHER },
      { name: 'Test Client', legalName: 'טסט קליינט (2019) בע"מ' },
    );
    expect(d.direction).toBe('expense');
    expect(d.rule).toBe('recipientName');
  });

  it('returns unknown on an empty document rather than a default', () => {
    const d = decide({ documentType: null });
    expect(d.direction).toBe('unknown');
    expect(d.rule).toBe('insufficient');
  });
});

describe('normalizeBusinessName', () => {
  it('treats the legal suffix as furniture', () => {
    expect(normalizeBusinessName('טסט קליינט בע"מ')).toBe(normalizeBusinessName('טסט קליינט'));
    expect(normalizeBusinessName('Acme Ltd.')).toBe(normalizeBusinessName('ACME'));
  });

  it('reads gershayim and an ASCII quote as the same character', () => {
    // Which one appears depends on whoever typed the client record, and they are
    // indistinguishable to a reader.
    expect(normalizeBusinessName('טסט קליינט בע״מ')).toBe(normalizeBusinessName('טסט קליינט בע"מ'));
  });

  it('does not collapse two genuinely different businesses', () => {
    expect(normalizeBusinessName('טסט קליינט')).not.toBe(normalizeBusinessName('טסט קליינטים'));
    expect(normalizeBusinessName('Acme')).not.toBe(normalizeBusinessName('Acme Holdings'));
  });

  it('does not eat a suffix that is part of a real word', () => {
    expect(normalizeBusinessName('Incoming Logistics')).toContain('incoming');
    expect(normalizeBusinessName('Coca Cola')).toContain('coca');
  });
});
