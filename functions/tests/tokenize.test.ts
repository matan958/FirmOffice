import { describe, expect, it } from 'vitest';
import { tokenize, wasTruncated } from '../src/ocr/tokenize.js';
import { MAX_SEARCH_TOKENS } from '../../shared/src/index.js';

/**
 * These tokens ARE the search index. Anything dropped here is permanently unfindable
 * until a backfill, so the cases that matter most are the ones asserting what must
 * survive — invoice numbers, Hebrew, mixed scripts.
 */

describe('tokenize — what must survive', () => {
  it('keeps invoice numbers, which are the most-searched thing in the corpus', () => {
    expect(tokenize('Invoice No. 12345')).toContain('12345');
  });

  it('keeps alphanumeric references intact rather than splitting them', () => {
    expect(tokenize('Ref ACME-2026-001')).toEqual(
      expect.arrayContaining(['acme', '2026', '001']),
    );
  });

  it('keeps Hebrew — \\w would discard it entirely', () => {
    const tokens = tokenize('חשבונית מס עבור שירותים');
    expect(tokens).toContain('חשבונית');
    expect(tokens).toContain('שירותים');
  });

  it('handles mixed Hebrew and Latin in one line', () => {
    const tokens = tokenize('Acme בעמ Invoice 4200');
    expect(tokens).toEqual(expect.arrayContaining(['acme', 'בעמ', 'invoice', '4200']));
  });

  it('lowercases so search is case-insensitive', () => {
    expect(tokenize('ACME Acme acme')).toEqual(['acme']);
  });
});

describe('tokenize — what is dropped', () => {
  it('drops single characters', () => {
    expect(tokenize('a b c hello')).toEqual(['hello']);
  });

  it('drops English and Hebrew stopwords', () => {
    expect(tokenize('the invoice for the client')).toEqual(['invoice', 'client']);
    expect(tokenize('של החברה')).not.toContain('של');
  });

  it('deduplicates', () => {
    expect(tokenize('invoice invoice invoice')).toEqual(['invoice']);
  });

  it('treats punctuation and whitespace as separators', () => {
    expect(tokenize('total:4,200.00\n\tVAT')).toEqual(
      expect.arrayContaining(['total', '200', '00', 'vat']),
    );
  });

  it('returns nothing for empty or symbol-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!! ... ???')).toEqual([]);
  });
});

describe('tokenize — the cap', () => {
  it('never exceeds MAX_SEARCH_TOKENS', () => {
    // One index entry per array element, against a ~40k per-document limit.
    const many = Array.from({ length: MAX_SEARCH_TOKENS * 3 }, (_, i) => `term${i}`).join(' ');
    expect(tokenize(many)).toHaveLength(MAX_SEARCH_TOKENS);
  });

  it('keeps first occurrences, so an invoice number near the top survives', () => {
    const filler = Array.from({ length: MAX_SEARCH_TOKENS * 2 }, (_, i) => `filler${i}`).join(' ');
    const tokens = tokenize(`invoice 12345 ${filler}`);
    expect(tokens).toContain('12345');
  });

  it('reports truncation so partial coverage is not mistaken for complete', () => {
    const many = Array.from({ length: MAX_SEARCH_TOKENS * 2 }, (_, i) => `term${i}`).join(' ');
    expect(wasTruncated(tokenize(many))).toBe(true);
    expect(wasTruncated(tokenize('short document'))).toBe(false);
  });

  it('does not let repeated boilerplate consume the cap', () => {
    // Dedup happens before the cap, so a page footer repeated 500 times costs 2 slots.
    const boilerplate = 'page footer '.repeat(500);
    expect(tokenize(`${boilerplate} uniqueterm`)).toContain('uniqueterm');
  });
});
