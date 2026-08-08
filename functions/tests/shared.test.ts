import { describe, expect, it } from 'vitest';
import { identifierKey, ingestAliasFrom, normalizeEmail } from '../../shared/src/constants.js';

/**
 * Pure-logic tests for the shared model helpers. No emulator needed, but they run in
 * the same suite so one command covers everything.
 */

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  John@Acme.COM ')).toBe('john@acme.com');
  });

  it('strips a +tag', () => {
    expect(normalizeEmail('john+invoices@acme.com')).toBe('john@acme.com');
  });

  it('strips dots for gmail, which treats them as insignificant', () => {
    expect(normalizeEmail('j.o.h.n@gmail.com')).toBe('john@gmail.com');
    expect(normalizeEmail('john@googlemail.com')).toBe('john@googlemail.com');
  });

  it('does NOT strip dots elsewhere — they are significant almost everywhere else', () => {
    // Collapsing these would merge two genuinely different people onto one client.
    expect(normalizeEmail('j.smith@acme.com')).toBe('j.smith@acme.com');
  });

  it('combines +tag stripping with gmail dot stripping', () => {
    expect(normalizeEmail('J.Smith+Receipts@Gmail.com')).toBe('jsmith@gmail.com');
  });

  it('leaves a malformed address alone rather than mangling it', () => {
    expect(normalizeEmail('not-an-email')).toBe('not-an-email');
    expect(normalizeEmail('@leading')).toBe('@leading');
  });

  it('keeps the last @ as the separator', () => {
    expect(normalizeEmail('a@b@acme.com')).toBe('a@b@acme.com');
  });
});

describe('ingestAliasFrom', () => {
  it('slugs the name and appends the suffix', () => {
    expect(ingestAliasFrom('Acme Ltd', '7k2x')).toBe('acmeltd7k2x');
  });

  it('drops punctuation and caps the slug length', () => {
    expect(ingestAliasFrom('Globex-International, Inc.', 'ab12')).toBe('globexinab12');
  });

  it('falls back when the name has no usable characters', () => {
    // Hebrew, Cyrillic or emoji-only names would otherwise produce a bare suffix.
    expect(ingestAliasFrom('חשבונאות', 'ab12')).toBe('clientab12');
  });
});

describe('identifierKey', () => {
  it('builds the composite document ID used for O(1) resolution', () => {
    expect(identifierKey('email', 'john@acme.com')).toBe('email:john@acme.com');
  });
});
