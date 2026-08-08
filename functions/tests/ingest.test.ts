import { describe, expect, it } from 'vitest';
import { classify, parseIncomingPath } from '../src/ingest/classify.js';

/**
 * The Gen 2 storage trigger fires for EVERY object in the bucket, including the
 * thumbnails and OCR output the pipeline writes itself. Path parsing is therefore the
 * difference between a working ingest and an infinite trigger loop, so it is tested
 * directly rather than only through the trigger.
 */

describe('parseIncomingPath', () => {
  it('parses a normal upload', () => {
    expect(parseIncomingPath('incoming/client-acme/doc123/invoice.pdf')).toEqual({
      clientId: 'client-acme',
      docId: 'doc123',
      fileName: 'invoice.pdf',
    });
  });

  it('rejoins a filename containing slashes', () => {
    expect(parseIncomingPath('incoming/c1/d1/scans/page 1.pdf')?.fileName).toBe('scans/page 1.pdf');
  });

  it('ignores prefixes the pipeline writes itself', () => {
    // If any of these parsed, the trigger would re-enter on its own output.
    expect(parseIncomingPath('thumbnails/doc123/page-1.jpg')).toBeNull();
    expect(parseIncomingPath('ocr-output/doc123/out.json')).toBeNull();
    expect(parseIncomingPath('ocr-text/doc123/fulltext.txt')).toBeNull();
    expect(parseIncomingPath('quarantine/doc123/bad.pdf')).toBeNull();
  });

  it('rejects paths that are too short to identify a document', () => {
    expect(parseIncomingPath('incoming/client-acme/doc123')).toBeNull();
    expect(parseIncomingPath('incoming/client-acme')).toBeNull();
    expect(parseIncomingPath('incoming')).toBeNull();
    expect(parseIncomingPath('')).toBeNull();
  });

  it('rejects empty path segments', () => {
    expect(parseIncomingPath('incoming//doc123/file.pdf')).toBeNull();
    expect(parseIncomingPath('incoming/c1//file.pdf')).toBeNull();
    expect(parseIncomingPath('incoming/c1/d1/')).toBeNull();
  });

  it('does not match a prefix that merely starts with "incoming"', () => {
    expect(parseIncomingPath('incoming-staging/c1/d1/file.pdf')).toBeNull();
  });
});

describe('classify', () => {
  it('routes OCR-able types to the OCR path', () => {
    expect(classify('application/pdf')).toBe('ocr');
    expect(classify('image/jpeg')).toBe('ocr');
    expect(classify('image/tiff')).toBe('ocr');
  });

  it('accepts office documents without trying to read them', () => {
    // An .xlsx bank statement is a document the firm needs; rejecting it because
    // nothing can OCR it would lose something a client legitimately sent.
    expect(
      classify('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe('store_only');
    expect(classify('text/csv')).toBe('store_only');
  });

  it('flags HEIC separately rather than rejecting it', () => {
    // Vision cannot read HEIC and iPhones send it constantly — dropping it silently
    // would look like ingestion is broken. OPEN ITEM #2 decides convert vs reject.
    expect(classify('image/heic')).toBe('needs_conversion');
    expect(classify('image/heif')).toBe('needs_conversion');
  });

  it('rejects everything else', () => {
    expect(classify('image/svg+xml')).toBe('reject');
    expect(classify('text/html')).toBe('reject');
    expect(classify('application/zip')).toBe('reject');
    expect(classify('application/octet-stream')).toBe('reject');
    expect(classify('')).toBe('reject');
  });
});
