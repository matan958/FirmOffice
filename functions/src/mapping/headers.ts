import { normalizeEmail } from '../shared.js';

/**
 * Pure email-header parsing. No firebase-admin, no network — everything here is
 * driven by strings so the whole mapping matrix can be unit-tested against synthetic
 * Gmail payloads without an emulator or a mailbox.
 *
 * The functions are deliberately forgiving. Header values in real mail are malformed
 * far more often than the RFCs suggest, and a parser that throws on a weird `From:`
 * takes the entire poller down with it — one bad message would stall ingestion for
 * the whole firm.
 */

export interface Header {
  name: string;
  value: string;
}

/** Case-insensitive lookup. Returns the FIRST occurrence, or null. */
export function header(headers: Header[], name: string): string | null {
  const wanted = name.toLowerCase();
  const hit = headers.find((h) => h.name?.toLowerCase() === wanted);
  return hit?.value ?? null;
}

/** Every occurrence — `Received` and `Authentication-Results` legitimately repeat. */
export function headerAll(headers: Header[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((h) => h.name?.toLowerCase() === wanted).map((h) => h.value ?? '');
}

/**
 * Pulls bare addresses out of a header value.
 *
 * Handles `Foo <a@b.com>`, bare `a@b.com`, and comma-separated lists of either.
 * Display names containing commas ("Doe, John" <j@d.com>) would break a naive split,
 * so angle-bracket forms are extracted first and removed before the remainder is
 * split — otherwise a quoted comma silently produces two garbage addresses.
 */
export function parseAddressList(value: string | null): string[] {
  if (!value) return [];

  const found: string[] = [];
  let rest = value;

  for (const match of value.matchAll(/<([^<>]+)>/g)) {
    const addr = match[1]?.trim();
    if (addr && addr.includes('@')) found.push(addr);
    rest = rest.replace(match[0], ' ');
  }

  // Strip quoted display names before splitting, so a comma inside quotes cannot
  // masquerade as a separator.
  rest = rest.replace(/"[^"]*"/g, ' ');

  for (const piece of rest.split(/[,;]/)) {
    const token = piece.trim().replace(/^[<(]|[>)]$/g, '');
    if (token.includes('@') && !/\s/.test(token)) found.push(token);
  }

  return found.map((a) => a.toLowerCase());
}

/** The single address a `From:`-style header names, or null. */
export function parseAddress(value: string | null): string | null {
  return parseAddressList(value)[0] ?? null;
}

/**
 * The `+tag` of an address, or null.
 *
 * `docs+acme7k2@firm.com` → `acme7k2`. This is the top rung of the mapping ladder:
 * unlike a sender address it survives forwarding, works from any device, and is a
 * value the firm assigns rather than one it has to discover.
 */
export function plusTagOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const local = address.slice(0, at);
  const plus = local.indexOf('+');
  if (plus < 0) return null;
  const tag = local.slice(plus + 1).trim().toLowerCase();
  return tag.length > 0 ? tag : null;
}

/**
 * Every `+tag` in `addresses` that was addressed to `mailbox`.
 *
 * Matching goes through normalizeEmail on both sides, so Gmail's dot-insensitivity is
 * handled: mail to `m.atan+acme@gmail.com` still resolves against a mailbox recorded
 * as `matan@gmail.com`. Without that, a client who types the address by hand and adds
 * a dot silently lands in Unassigned forever.
 */
export function aliasTagsFor(addresses: string[], mailbox: string): string[] {
  const base = normalizeEmail(mailbox);
  const tags: string[] = [];
  for (const address of addresses) {
    if (normalizeEmail(address) !== base) continue;
    const tag = plusTagOf(address);
    if (tag) tags.push(tag);
  }
  return tags;
}

export interface AuthResults {
  /** null when the header is absent — "unknown", which is NOT the same as "failed". */
  dkimPass: boolean | null;
  spfPass: boolean | null;
  dmarcPass: boolean | null;
}

/**
 * Reads `Authentication-Results`, the receiving server's verdict on whether the
 * message really came from where `From:` claims.
 *
 * A `From:` header is plain text that anyone can write, so for a CPA firm this is the
 * difference between filing an invoice under the right client and filing a forgery.
 *
 * Two subtleties that matter:
 *
 * - Mail traverses several hops and each may add its own header. Only the header
 *   added by the mailbox provider is trustworthy — an attacker can fabricate the
 *   others upstream. Gmail's carries `mx.google.com`, so it is preferred when
 *   present rather than simply taking the first.
 * - `dkim=none` means "not signed", not "signature invalid". Plenty of legitimate
 *   small senders never sign. It is reported as false here and the auto-assign rule
 *   in resolveClient.ts treats DKIM and SPF as alternatives rather than requiring
 *   both, so an unsigned-but-SPF-valid sender is not exiled to Unassigned forever.
 */
export function parseAuthResults(values: string[]): AuthResults {
  if (values.length === 0) return { dkimPass: null, spfPass: null, dmarcPass: null };

  const preferred = values.find((v) => v.toLowerCase().includes('mx.google.com')) ?? values[0]!;
  const lower = preferred.toLowerCase();

  const verdict = (method: string): boolean | null => {
    const m = lower.match(new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`));
    if (!m) return null;
    return m[1] === 'pass';
  };

  return {
    dkimPass: verdict('dkim'),
    spfPass: verdict('spf'),
    dmarcPass: verdict('dmarc'),
  };
}

/** Domain part of an address, lowercased, or null. */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

const FORWARD_SUBJECT_RE = /^\s*(fwd?|forwarded)\s*:/i;

/**
 * The original sender of a forwarded message, or null.
 *
 * This rung exists because of a specific, very common workflow: a client mails the
 * accountant directly, the accountant forwards it to the ingest address, and the
 * `From:` header is now the accountant. Without this every such document files itself
 * under the firm's own staff — or nowhere.
 *
 * The quoted header block is plain body text with no standard format, so this is
 * pattern matching, not parsing, and it is scored at 0.7 for exactly that reason.
 * Only the FIRST quoted `From:` is used: a long forwarding chain has several, and the
 * outermost is the closest to the sender we actually care about.
 */
export function forwardedSender(subject: string | null, body: string | null): string | null {
  if (!body) return null;

  const looksForwarded =
    (subject !== null && FORWARD_SUBJECT_RE.test(subject)) ||
    /-{2,}\s*(forwarded message|original message)\s*-{2,}/i.test(body) ||
    /^\s*begin forwarded message:/im.test(body);

  if (!looksForwarded) return null;

  // Deliberately anchored to a line start: `From:` appears inside ordinary prose
  // ("the invoice from: Acme") often enough to matter, and an unanchored match would
  // happily file a document under whatever address prose mentioned first.
  const match = body.match(/^\s*(?:>\s*)*from:\s*(.+)$/im);
  return match ? parseAddress(match[1] ?? null) : null;
}

/** The `[CODE]` a client was asked to put in the subject line, or null. */
export function subjectCode(subject: string | null, re: RegExp): string | null {
  if (!subject) return null;
  const m = subject.match(re);
  return m?.[1]?.toLowerCase() ?? null;
}
