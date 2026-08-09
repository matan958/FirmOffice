import { describe, expect, it } from 'vitest';
import { syncPageRange } from '../src/ocr/vision.js';
import { VISION_LANGUAGE_HINTS, VISION_SYNC_PAGE_LIMIT } from '../src/shared.js';

/**
 * Cloud Vision has no emulator. Everything that talks to it is therefore either
 * injected behind the OcrEngine interface or, like this, pulled out as pure logic —
 * because the alternative way to discover a wrong request shape is to pay for a real
 * call and read the rejection.
 *
 * This particular list is worth pinning: Vision rejects a `batchAnnotateFiles`
 * request outright when `pages` names a page the file does not have, and the previous
 * fixed [1,2,3,4,5] did exactly that for any scanned PDF shorter than five pages.
 */

describe('syncPageRange', () => {
  it('asks only for pages that exist', () => {
    expect(syncPageRange(1)).toEqual([1]);
    expect(syncPageRange(2)).toEqual([1, 2]);
    expect(syncPageRange(4)).toEqual([1, 2, 3, 4]);
  });

  it('caps at the synchronous limit', () => {
    expect(syncPageRange(5)).toEqual([1, 2, 3, 4, 5]);
    // Longer files take the async path, but the cap must hold regardless.
    expect(syncPageRange(500)).toHaveLength(VISION_SYNC_PAGE_LIMIT);
  });

  it('never returns an empty list', () => {
    // An empty `pages` is not "no pages" to Vision — it means "default to the first
    // five", which is the out-of-range failure this function exists to avoid.
    expect(syncPageRange(0)).toEqual([1]);
    expect(syncPageRange(-3)).toEqual([1]);
    expect(syncPageRange(Number.NaN)).toEqual([1]);
  });

  it('is 1-based, never 0-based', () => {
    expect(syncPageRange(3)).not.toContain(0);
    expect(syncPageRange(3)[0]).toBe(1);
  });
});

describe('language hints', () => {
  it('names Hebrew and English, and stays short', () => {
    // Hints bias detection rather than filtering it, so a long list degrades accuracy
    // instead of covering more ground. Hebrew is listed because the firm's documents
    // are Israeli and mis-detected RTL text comes back as confident-looking nonsense
    // rather than as an error anyone would notice.
    expect(VISION_LANGUAGE_HINTS).toContain('he');
    expect(VISION_LANGUAGE_HINTS).toContain('en');
    expect(VISION_LANGUAGE_HINTS.length).toBeLessThanOrEqual(3);
  });
});
