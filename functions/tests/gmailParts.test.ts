import { describe, expect, it } from 'vitest';
import { plainTextBody, scanAttachments, type GmailMessage, type GmailPart } from '../src/gmail/parts.js';
import { INLINE_IMAGE_MAX_BYTES, MAX_FILE_BYTES } from '../src/shared.js';

/**
 * Attachment selection. Both failure directions are silent: filtering too little
 * fills the Inbox with signature logos until accountants stop reading it, and
 * filtering too much drops a client's invoice with nothing to show it happened.
 */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function message(payload: GmailPart, over: Partial<GmailMessage> = {}): GmailMessage {
  return { id: 'm1', threadId: 't1', internalDate: '1754640000000', payload, ...over };
}

function attachmentPart(over: Partial<GmailPart> = {}): GmailPart {
  return {
    mimeType: 'application/pdf',
    filename: 'invoice.pdf',
    body: { attachmentId: 'att-1', size: 40_000 },
    ...over,
  };
}

describe('scanAttachments', () => {
  it('selects a normal PDF attachment', () => {
    const scan = scanAttachments(
      message({ mimeType: 'multipart/mixed', parts: [attachmentPart()] }),
    );

    expect(scan.attachments).toHaveLength(1);
    expect(scan.attachments[0]).toMatchObject({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      attachmentId: 'att-1',
      sizeBytes: 40_000,
    });
    expect(scan.needsAttention).toBe(false);
  });

  it('ignores body parts, which have no filename', () => {
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { size: 20, data: b64('hello') } },
          { mimeType: 'text/html', body: { size: 40, data: b64('<p>hello</p>') } },
        ],
      }),
    );
    expect(scan.attachments).toHaveLength(0);
  });

  it('drops a signature logo referenced by Content-ID', () => {
    // Without this every message from a corporate sender spawns junk documents.
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/related',
        parts: [
          attachmentPart(),
          {
            mimeType: 'image/png',
            filename: 'logo.png',
            headers: [{ name: 'Content-ID', value: '<logo@acme>' }],
            body: { attachmentId: 'att-2', size: 8_000 },
          },
        ],
      }),
    );

    expect(scan.attachments.map((a) => a.filename)).toEqual(['invoice.pdf']);
    expect(scan.skipped).toContainEqual({
      filename: 'logo.png',
      mimeType: 'image/png',
      reason: 'inline-image',
    });
  });

  it('KEEPS a large inline image — a phone can send a real receipt inline', () => {
    // Size is a second condition, not the test. Dropping every inline image loses
    // genuine documents from phone mail clients, which is the harder failure to see.
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/related',
        parts: [
          {
            mimeType: 'image/jpeg',
            filename: 'receipt.jpg',
            headers: [{ name: 'Content-ID', value: '<img001>' }],
            body: { attachmentId: 'att-3', size: INLINE_IMAGE_MAX_BYTES + 1 },
          },
        ],
      }),
    );
    expect(scan.attachments.map((a) => a.filename)).toEqual(['receipt.jpg']);
  });

  it('flags an archive for a human instead of storing it', () => {
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/mixed',
        parts: [attachmentPart({ mimeType: 'application/zip', filename: 'docs.zip' })],
      }),
    );

    expect(scan.attachments).toHaveLength(0);
    expect(scan.needsAttention).toBe(true);
    expect(scan.skipped[0]?.reason).toBe('container');
  });

  it('flags a forwarded .eml rather than storing an unreadable container', () => {
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/mixed',
        parts: [attachmentPart({ mimeType: 'message/rfc822', filename: 'fwd.eml' })],
      }),
    );
    expect(scan.needsAttention).toBe(true);
    expect(scan.attachments).toHaveLength(0);
  });

  it('flags an oversized attachment', () => {
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/mixed',
        parts: [attachmentPart({ body: { attachmentId: 'a', size: MAX_FILE_BYTES + 1 } })],
      }),
    );
    expect(scan.skipped[0]?.reason).toBe('too-large');
    expect(scan.needsAttention).toBe(true);
  });

  it('skips zero-byte and body-less parts', () => {
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/mixed',
        parts: [
          attachmentPart({ filename: 'empty.pdf', body: { attachmentId: 'a', size: 0 } }),
          { mimeType: 'application/pdf', filename: 'nobody.pdf' },
        ],
      }),
    );
    expect(scan.attachments).toHaveLength(0);
    expect(scan.skipped.map((s) => s.reason)).toEqual(['empty', 'empty']);
  });

  it('assigns indices from a stable depth-first walk', () => {
    // The idempotency key is messageId + index, NOT attachmentId — Gmail does not
    // promise attachmentId is the same value on a later fetch of the same message,
    // and a changing key would re-ingest the entire lookback window every run.
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/mixed',
        parts: [
          attachmentPart({ filename: 'a.pdf' }),
          {
            mimeType: 'multipart/related',
            parts: [attachmentPart({ filename: 'b.pdf' }), attachmentPart({ filename: 'c.pdf' })],
          },
        ],
      }),
    );
    expect(scan.attachments.map((a) => [a.filename, a.index])).toEqual([
      ['a.pdf', 0],
      ['b.pdf', 1],
      ['c.pdf', 2],
    ]);
  });

  it('keeps indices stable when an earlier part is filtered out', () => {
    // Indices count every NAMED part, filtered or not. If they were assigned after
    // filtering, a change to the filter rules would renumber existing attachments and
    // silently re-ingest documents the firm already holds.
    const withLogo = scanAttachments(
      message({
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'image/png',
            filename: 'logo.png',
            headers: [{ name: 'Content-ID', value: '<l>' }],
            body: { attachmentId: 'x', size: 900 },
          },
          attachmentPart({ filename: 'real.pdf' }),
        ],
      }),
    );
    expect(withLogo.attachments[0]).toMatchObject({ filename: 'real.pdf', index: 1 });
  });

  it('detects Drive links, whose bytes are not in the message at all', () => {
    // Gmail replaces attachments over 25 MB with a link. The message looks empty to
    // us and looked like "I sent you the file" to the client.
    const scan = scanAttachments(
      message({
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'text/plain',
            body: {
              size: 90,
              data: b64('Here it is: https://drive.google.com/file/d/1AbCd-eF_gh/view thanks'),
            },
          },
          attachmentPart(),
        ],
      }),
    );

    expect(scan.driveLinks).toEqual(['https://drive.google.com/file/d/1AbCd-eF_gh']);
    expect(scan.needsAttention).toBe(true);
  });
});

describe('plainTextBody', () => {
  it('prefers the text/plain part', () => {
    const body = plainTextBody(
      message({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { size: 5, data: b64('plain') } },
          { mimeType: 'text/html', body: { size: 20, data: b64('<p>html</p>') } },
        ],
      }),
    );
    expect(body).toBe('plain');
  });

  it('falls back to stripping HTML, keeping line structure for the forward parser', () => {
    // The forwarded-sender matcher anchors `From:` to a line start, so the tag
    // stripping has to preserve <br> and block-level breaks as newlines.
    const body = plainTextBody(
      message({
        mimeType: 'text/html',
        body: { size: 60, data: b64('<div>FYI</div><div>From: a@b.com</div>') },
      }),
    );
    expect(body).toContain('\nFrom: a@b.com');
  });

  it('returns null when there is no body at all', () => {
    expect(plainTextBody(message({ mimeType: 'application/pdf', filename: 'x.pdf' }))).toBeNull();
  });
});
