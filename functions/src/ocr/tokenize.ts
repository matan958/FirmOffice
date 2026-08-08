import { MAX_SEARCH_TOKENS, MIN_TOKEN_LENGTH, SEARCH_STOPWORDS } from '../shared.js';

/**
 * Reduces OCR text to the token array that backs document search.
 *
 * Firestore cannot match substrings, so search is `array-contains` over these tokens:
 * whole words only, no prefix and no typo tolerance. That is the accepted cost of
 * keeping clients' financial text inside the firm's own project rather than mirroring
 * it continuously into a third-party search service.
 *
 * Unicode-aware by necessity — `\w` would discard Hebrew entirely, and an Israeli
 * CPA firm's documents are largely Hebrew. `\p{L}\p{N}` keeps letters and digits in
 * every script, which also preserves invoice numbers, the single most-searched thing
 * in the corpus.
 */

/** Letters and digits in any script; everything else is a separator. */
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  if (!text) return [];

  const seen = new Set<string>();

  for (const match of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
    const token = match[0];

    if (token.length < MIN_TOKEN_LENGTH) continue;
    // Stopwords are dropped BEFORE the cap so they cannot crowd out distinctive terms.
    if (SEARCH_STOPWORDS.has(token)) continue;

    seen.add(token);
    // First-occurrence order, not frequency: an invoice number appears once, near the
    // top, and is exactly what someone searches for. Ranking by frequency would push
    // it out in favour of boilerplate that repeats on every page.
    if (seen.size >= MAX_SEARCH_TOKENS) break;
  }

  return [...seen];
}

/**
 * True when the cap truncated the text, so the caller can record that search coverage
 * on this document is partial rather than letting it look complete.
 */
export function wasTruncated(tokens: string[]): boolean {
  return tokens.length >= MAX_SEARCH_TOKENS;
}
