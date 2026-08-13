import {
  AUTO_ASSIGN_MIN_CONFIDENCE,
  MATCH_CONFIDENCE,
  PUBLIC_EMAIL_DOMAINS,
  SUBJECT_CODE_RE,
  identifierKey,
  normalizeEmail,
} from '../shared.js';
import type { ClientIdentifierDoc, ClientMatchMethod } from '../shared.js';
import {
  aliasTagsFor,
  domainOf,
  forwardedSender,
  subjectCode,
  type AuthResults,
} from './headers.js';

/**
 * The Gmail → client resolution ladder.
 *
 * Pure by construction: identifier reads come in through an injected `lookup`, so the
 * entire mapping matrix — alias hit, exact email, corporate domain, a gmail.com
 * sender that must NOT domain-match, a forward, a DKIM failure — is unit-testable
 * against synthetic inputs with no emulator and no mailbox.
 *
 * ── Three things this file is careful about ──
 *
 * **Only the client's own registered address may file a document.** That is the firm's
 * rule: a client IS their email address. Mail from it is theirs; mail from anywhere
 * else waits in Unassigned for a human. Every other rung below still runs and can still
 * name a candidate, but none of them can assign one — see `Hit.assigns`.
 *
 * **It never guesses into `clientId`.** A rung can produce a candidate that is not
 * good enough to file on, and those are returned as `suggestedClientId` with
 * `clientId` still null. The document lands in Unassigned where a human decides, but
 * the UI can offer the guess as one click. Filing a wrong guess is not a smaller
 * error than filing nothing — it is a larger one, because nobody goes looking.
 *
 * **Rungs run in descending confidence order, which is NOT the order in the plan's
 * table.** That table lists domain (0.60) above subject code (0.85) and forwarded
 * (0.70). Combined with "stop at the first hit", that ordering would let a weak
 * domain match pre-empt a strong subject code on the same message — a corporate
 * sender with an explicit client code in the subject would file by domain instead.
 * First-hit-wins is only sound if the rungs are strongest-first.
 */

export interface MessageIdentity {
  /** Bare address from `From:`. */
  from: string | null;
  /** To + Cc + Delivered-To + X-Original-To, deduplicated. Alias rung reads these. */
  recipients: string[];
  replyTo: string | null;
  subject: string | null;
  /** Plain-text body, used only to detect and parse a forward. */
  bodyText: string | null;
  auth: AuthResults;
}

export type IdentifierLookup = (key: string) => Promise<ClientIdentifierDoc | null>;

export interface Resolution {
  /** Non-null ONLY when confidence cleared AUTO_ASSIGN_MIN_CONFIDENCE. */
  clientId: string | null;
  method: ClientMatchMethod;
  confidence: number;
  matchedIdentifier: string | null;
  /** A candidate found but not filed on. Null when nothing matched at all. */
  suggestedClientId: string | null;
  /** True when a rung matched and sender authentication cut its confidence. */
  authDowngraded: boolean;
  /** The `+tag` the message was addressed to, recorded on the document either way. */
  aliasTag: string | null;
}

/**
 * Multiplier applied when the receiving server says the sender is not who `From:`
 * claims. 0.5 is chosen so that it drops every sender-derived rung below the
 * auto-assign floor (0.95 → 0.48, 0.60 → 0.30): a failing message is never filed
 * automatically, whichever rung matched it.
 */
const AUTH_FAIL_FACTOR = 0.5;

/**
 * Explicit failure, not merely unproven.
 *
 * DKIM and SPF are treated as ALTERNATIVES rather than both being required. Many
 * legitimate small senders — exactly the sort of business a small CPA firm has as
 * clients — never sign with DKIM, and demanding it would leave them permanently in
 * Unassigned, which trains accountants to click through the queue without reading it.
 *
 * `null` means the header was absent or unparseable, which is not evidence of
 * forgery, so it does not downgrade. In production Gmail always adds this header, so
 * null there means the parse failed and is worth a log line, not a rejection.
 */
function authFailed(auth: AuthResults): boolean {
  return auth.dkimPass === false && auth.spfPass === false;
}

interface Hit {
  method: ClientMatchMethod;
  key: string;
  identifier: ClientIdentifierDoc;
  /** How we found it — this caps the score regardless of the identifier's own. */
  ceiling: number;
  /** False for rungs whose evidence does not depend on the `From:` header. */
  sensitiveToAuth: boolean;
  /**
   * Whether this rung is allowed to file a document at all.
   *
   * TRUE ON EXACTLY ONE RUNG: the exact registered sender address. The firm's rule is
   * that a client is their email address — mail from it is theirs, and mail from
   * anywhere else is Unassigned until a human says otherwise.
   *
   * The other rungs still run, and still produce `suggestedClientId`, because a wrong
   * guess and no guess are very different costs: filing to the wrong client hides a
   * document in someone else's folder, while a suggestion on the Unassigned row turns
   * a search into one click. So they inform; they never decide.
   *
   * Deliberately a flag rather than a confidence threshold. Expressing "only email may
   * assign" by raising AUTO_ASSIGN_MIN_CONFIDENCE above 0.85 would work today and break
   * silently the moment anyone retunes a number in MATCH_CONFIDENCE — and it would
   * still let the 1.00 alias rung through.
   */
  assigns: boolean;
}

function ceilingFor(method: ClientMatchMethod): number {
  return MATCH_CONFIDENCE[method] ?? 0.5;
}

export async function resolveClient(
  message: MessageIdentity,
  lookup: IdentifierLookup,
  options: { ingestMailbox: string },
): Promise<Resolution> {
  const aliasTags = aliasTagsFor(message.recipients, options.ingestMailbox);
  const hit = await firstHit(message, lookup, aliasTags);

  if (!hit) {
    return {
      clientId: null,
      method: 'none',
      confidence: 0,
      matchedIdentifier: null,
      suggestedClientId: null,
      authDowngraded: false,
      aliasTag: aliasTags[0] ?? null,
    };
  }

  // The identifier's stored confidence can only LOWER the score, never raise it: it
  // lets an accountant mark a shared mailbox as unreliable, but must not let an
  // `email:` row scored 0.95 lend that score to a 0.70 forwarded match that merely
  // happened to find it.
  let confidence = Math.min(hit.ceiling, hit.identifier.confidence ?? hit.ceiling);

  const downgraded = hit.sensitiveToAuth && authFailed(message.auth);
  if (downgraded) confidence *= AUTH_FAIL_FACTOR;

  // Both conditions, not either. `assigns` is the firm's rule — only a message from a
  // client's own registered address files itself. The confidence floor still applies on
  // top of it, which is what stops a spoofed sender from filing: an exact-address match
  // whose DKIM and SPF both failed scores 0.48 and drops to a suggestion.
  const assign = hit.assigns && confidence >= AUTO_ASSIGN_MIN_CONFIDENCE;

  return {
    clientId: assign ? hit.identifier.clientId : null,
    method: hit.method,
    confidence,
    matchedIdentifier: hit.key,
    suggestedClientId: assign ? null : hit.identifier.clientId,
    authDowngraded: downgraded,
    aliasTag: aliasTags[0] ?? null,
  };
}

/** Rungs, strongest first. Returns at the first identifier that actually exists. */
async function firstHit(
  message: MessageIdentity,
  lookup: IdentifierLookup,
  aliasTags: string[],
): Promise<Hit | null> {
  const senderRung = async (
    address: string | null,
    method: ClientMatchMethod,
    ceiling: number,
  ): Promise<Hit | null> => {
    if (!address) return null;
    const key = identifierKey('email', normalizeEmail(address));
    const identifier = await lookup(key);
    return identifier
      ? // `assigns` only for the exact-sender rung. `forwarded` and `replyTo` reach this
        // same helper and read the same `email:` rows, but the address they matched was
        // recovered from a body or a header rather than being who sent the message.
        { method, key, identifier, ceiling, sensitiveToAuth: true, assigns: method === 'email' }
      : null;
  };

  // ── 1. Plus-address alias (1.00) ──────────────────────────────────────────
  // Not gated on sender authentication, and that is deliberate: the evidence is the
  // address the message was DELIVERED to, which the sender cannot forge into our
  // mailbox — a spoofed `From:` tells us nothing about it. This is also why the alias
  // is worth pushing as the primary mechanism: it is the only rung that is both
  // high-confidence and immune to header forgery.
  for (const tag of aliasTags) {
    const key = identifierKey('alias', tag);
    const identifier = await lookup(key);
    if (identifier) {
      return {
        method: 'alias',
        key,
        identifier,
        ceiling: ceilingFor('alias'),
        sensitiveToAuth: false,
        assigns: false,
      };
    }
  }

  // ── 2. Exact sender address (0.95) ────────────────────────────────────────
  const byEmail = await senderRung(message.from, 'email', ceilingFor('email'));
  if (byEmail) return byEmail;

  // ── 3. Subject-line code (0.85) ───────────────────────────────────────────
  // Like the alias, this is a token the firm issued rather than an identity claim,
  // so it does not depend on `From:` being genuine.
  const code = subjectCode(message.subject, SUBJECT_CODE_RE);
  if (code) {
    const key = identifierKey('subjectCode', code);
    const identifier = await lookup(key);
    if (identifier) {
      return {
        method: 'subjectCode',
        key,
        identifier,
        ceiling: ceilingFor('subjectCode'),
        sensitiveToAuth: false,
        assigns: false,
      };
    }
  }

  // ── 4. Forwarded original sender (0.70) ───────────────────────────────────
  const forwarded = forwardedSender(message.subject, message.bodyText);
  if (forwarded) {
    const hit = await senderRung(forwarded, 'forwarded', ceilingFor('forwarded'));
    // Auth on a forward describes the FORWARDER, not the original sender, so it says
    // nothing about whether the quoted address is genuine. The 0.70 ceiling already
    // prices that in; applying the penalty on top would double-count it.
    if (hit) return { ...hit, sensitiveToAuth: false };
  }

  // ── 5. Sender domain (0.60) ───────────────────────────────────────────────
  // The blocklist is load-bearing, not a nicety. One `domain:gmail.com` row would map
  // every Gmail user on earth to a single client, and it would be created by the most
  // natural action available: an accountant ticking "always file mail from this
  // domain" on a client who happens to use a personal address.
  const senderDomain = message.from ? domainOf(message.from) : null;
  if (senderDomain && !PUBLIC_EMAIL_DOMAINS.has(senderDomain)) {
    const key = identifierKey('domain', senderDomain);
    const identifier = await lookup(key);
    if (identifier) {
      return {
        method: 'domain',
        key,
        identifier,
        ceiling: ceilingFor('domain'),
        sensitiveToAuth: true,
        assigns: false,
      };
    }
  }

  // ── 6. Reply-To (0.50) ────────────────────────────────────────────────────
  // Below the auto-assign floor by design, so this rung can only ever produce a
  // suggestion. It earns its place for mail relayed through a mailing list or a
  // bookkeeping portal, where `From:` is the relay and `Reply-To:` is the human.
  if (message.replyTo && normalizeEmail(message.replyTo) !== normalizeEmail(message.from ?? '')) {
    const hit = await senderRung(message.replyTo, 'replyTo', ceilingFor('replyTo'));
    if (hit) return hit;
  }

  return null;
}
