import { describe, expect, it } from 'vitest';
import { convertedPath, jpegNameFor } from '../src/ingest/convertHeic.js';
import { parseIncomingPath } from '../src/ingest/classify.js';

/**
 * The conversion itself needs real HEIC bytes and is exercised end-to-end against the
 * emulator; what is pinned here is the naming and — critically — that the output path
 * cannot re-enter the ingest trigger.
 */

describe('jpegNameFor', () => {
  it('replaces the extension', () => {
    expect(jpegNameFor('photo.heic')).toBe('photo.jpg');
    expect(jpegNameFor('photo.HEIC')).toBe('photo.jpg');
    expect(jpegNameFor('scan.heif')).toBe('scan.jpg');
  });

  it('only replaces the final extension', () => {
    expect(jpegNameFor('invoice.2026.heic')).toBe('invoice.2026.jpg');
  });

  it('appends when there is no extension', () => {
    expect(jpegNameFor('photo')).toBe('photo.jpg');
  });

  it('does not treat a dot in a directory name as an extension', () => {
    expect(jpegNameFor('scans.v2/photo')).toBe('scans.v2/photo.jpg');
  });
});

describe('convertedPath — must not re-enter the ingest trigger', () => {
  it('writes outside incoming/', () => {
    const path = convertedPath('doc123', 'photo.heic');
    expect(path).toBe('converted/doc123/photo.jpg');
  });

  it('is ignored by the ingest path parser', () => {
    // If this ever parsed, converting a HEIC would re-fire the trigger on its own
    // output — the classic storage-trigger loop, and an expensive one.
    expect(parseIncomingPath(convertedPath('doc123', 'photo.heic'))).toBeNull();
    expect(parseIncomingPath(convertedPath('d', 'a/b/photo.heic'))).toBeNull();
  });
});
