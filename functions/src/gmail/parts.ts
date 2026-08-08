import { CONTAINER_MIME, INLINE_IMAGE_MAX_BYTES, MAX_FILE_BYTES } from '../shared.js';
import { header, type Header } from '../mapping/headers.js';

/**
 * Walking a Gmail message's MIME tree to decide what is a document and what is not.
 *
 * Pure, and tested directly, because the two failure modes here are both quiet:
 * filtering too little floods the Inbox with signature logos until accountants stop
 * reading it, and filtering too much silently drops a client's invoice.
 */

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  /** Epoch milliseconds, as a string. Gmail's own receipt time. */
  internalDate?: string;
  payload?: GmailPart;
}

export interface SelectedAttachment {
  /**
   * Position in the depth-first walk of THIS message.
   *
   * The idempotency key is built from `messageId` + this index, deliberately not from
   * `attachmentId`. Gmail's attachmentId is a handle for one `messages.get` response
   * and is not guaranteed to be the same value the next time the same message is
   * fetched — so keying the ledger on it makes every re-poll look like new
   * attachments and re-ingests the entire lookback window. Position within a message
   * is immutable; the message itself is immutable.
   */
  index: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Fetch separately via `attachments.get`. Null when Gmail inlined the bytes. */
  attachmentId: string | null;
  /** base64url payload, present for small parts Gmail returns inline. */
  inlineData: string | null;
}

export type SkipReason =
  | 'inline-image'
  | 'container'
  | 'too-large'
  | 'empty'
  | 'no-filename';

export interface SkippedPart {
  filename: string;
  mimeType: string;
  reason: SkipReason;
}

export interface AttachmentScan {
  attachments: SelectedAttachment[];
  skipped: SkippedPart[];
  /**
   * True when something arrived that a human should look at — an archive, an
   * oversized file, or a Drive link. The poller labels those messages rather than
   * marking them processed, so they surface in the mailbox instead of evaporating.
   */
  needsAttention: boolean;
  /**
   * Gmail replaces attachments over 25 MB with Drive links in the body. Those bytes
   * are not in the message at all, so there is nothing to ingest — but a message that
   * looks empty to us looked like "I sent you the file" to the client.
   */
  driveLinks: string[];
}

const DRIVE_LINK_RE = /https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?[^\s"'<>]*id=)[\w-]+/g;

/** Gmail encodes every body and attachment as base64url — `-`/`_`, usually unpadded. */
export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data, 'base64url');
}

/** Depth-first, so `index` is stable for a given message. */
function walk(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!part) return out;
  out.push(part);
  for (const child of part.parts ?? []) walk(child, out);
  return out;
}

/**
 * Whether a part is email furniture rather than a document.
 *
 * A signature logo, a social icon, or a tracking pixel is an attachment by every
 * structural measure — it has a filename and its own body. What distinguishes it is
 * that the HTML body references it by `Content-ID`, so it is displayed as part of the
 * message rather than offered for download.
 *
 * The size ceiling is a second condition, not the primary one: a genuine scanned
 * receipt is occasionally sent inline by a phone mail client, and rejecting it purely
 * for being inline would drop real documents. Both conditions must hold.
 */
function isInlineFurniture(part: GmailPart, size: number): boolean {
  if (!part.mimeType?.startsWith('image/')) return false;
  if (size > INLINE_IMAGE_MAX_BYTES) return false;

  const headers = part.headers ?? [];
  const contentId = header(headers, 'Content-ID');
  const disposition = header(headers, 'Content-Disposition') ?? '';
  return Boolean(contentId) || disposition.toLowerCase().startsWith('inline');
}

/** The first text/plain body, used only to detect and parse a forward. */
export function plainTextBody(message: GmailMessage): string | null {
  const parts = walk(message.payload);

  const plain = parts.find(
    (p) => p.mimeType === 'text/plain' && !p.filename && p.body?.data,
  );
  if (plain?.body?.data) return decodeBase64Url(plain.body.data).toString('utf8');

  // Fall back to stripping the HTML alternative. Crude, but this text is only ever
  // fed to the forwarded-sender matcher, which anchors on `From:` at a line start.
  const html = parts.find((p) => p.mimeType === 'text/html' && !p.filename && p.body?.data);
  if (!html?.body?.data) return null;

  return decodeBase64Url(html.body.data)
    .toString('utf8')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|tr|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function scanAttachments(message: GmailMessage): AttachmentScan {
  const attachments: SelectedAttachment[] = [];
  const skipped: SkippedPart[] = [];
  let needsAttention = false;
  let index = 0;

  for (const part of walk(message.payload)) {
    // A part with no filename is message structure — the body, an alternative, a
    // multipart container. Only named parts are candidate documents.
    if (!part.filename) continue;

    const filename = part.filename;
    const mimeType = part.mimeType ?? 'application/octet-stream';
    const size = part.body?.size ?? 0;
    const position = index++;

    if (!part.body?.attachmentId && !part.body?.data) {
      skipped.push({ filename, mimeType, reason: 'empty' });
      continue;
    }
    if (size === 0) {
      skipped.push({ filename, mimeType, reason: 'empty' });
      continue;
    }
    if (isInlineFurniture(part, size)) {
      skipped.push({ filename, mimeType, reason: 'inline-image' });
      continue;
    }
    if ((CONTAINER_MIME as readonly string[]).includes(mimeType)) {
      // Storing a .zip would give the firm a document it cannot read, OCR or search,
      // which is worse than a visible refusal. Unpacking is M6.
      skipped.push({ filename, mimeType, reason: 'container' });
      needsAttention = true;
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped.push({ filename, mimeType, reason: 'too-large' });
      needsAttention = true;
      continue;
    }

    attachments.push({
      index: position,
      filename,
      mimeType,
      sizeBytes: size,
      attachmentId: part.body.attachmentId ?? null,
      inlineData: part.body.data ?? null,
    });
  }

  const body = plainTextBody(message) ?? '';
  const driveLinks = [...new Set(body.match(DRIVE_LINK_RE) ?? [])];
  if (driveLinks.length > 0) needsAttention = true;

  return { attachments, skipped, needsAttention, driveLinks };
}
