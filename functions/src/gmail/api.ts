import { OAuth2Client } from 'google-auth-library';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import type { GmailMessage } from './parts.js';

/**
 * A thin Gmail REST client.
 *
 * Deliberately hand-rolled over `google-auth-library` rather than pulling in
 * `googleapis`: that package ships generated clients for every Google API and adds
 * tens of megabytes to a Functions deployment, which is paid on every cold start. Six
 * endpoints are needed here, and OAuth2Client already handles the only genuinely
 * fiddly part — exchanging the refresh token and re-exchanging it when the access
 * token expires mid-run.
 */

export const GMAIL_CLIENT_ID = defineSecret('GMAIL_CLIENT_ID');
export const GMAIL_CLIENT_SECRET = defineSecret('GMAIL_CLIENT_SECRET');
export const GMAIL_REFRESH_TOKEN = defineSecret('GMAIL_REFRESH_TOKEN');

/** All three, for a function's `secrets` option. */
export const GMAIL_SECRETS = [GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN];

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Raised when the refresh token itself is dead — revoked, or expired because the
 * OAuth consent screen is still in "Testing", where Google expires refresh tokens
 * after seven days.
 *
 * This is called out as its own error type because of how it presents: ingestion
 * simply stops, and a mailbox that yields no new documents is indistinguishable from
 * a quiet week. Left as a generic 400 it would be diagnosed as "the poller broke"
 * long after the first missed document.
 */
export class GmailAuthError extends Error {
  constructor(cause: string) {
    // Two different faults with two different remedies, and OAuth names them almost
    // identically. `invalid_grant` is a dead refresh token. `invalid_client` is the
    // ID/secret pair being wrong, where the token is fine and re-minting it — the
    // obvious move, and the one the old single message sent people towards — changes
    // nothing at all.
    const clientProblem = /invalid_client|unauthorized_client/i.test(cause);
    super(
      clientProblem
        ? `Gmail rejected the OAuth CLIENT (${cause}). GMAIL_CLIENT_ID and ` +
            `GMAIL_CLIENT_SECRET do not match a client in this project. The refresh ` +
            `token is not the problem and re-minting it will not help. Re-set those two ` +
            `secrets, then REDEPLOY — a deploy pins an exact secret version, so a new ` +
            `version has no effect until the functions are deployed again.`
        : `Gmail refused the stored refresh TOKEN (${cause}). It is revoked or expired. ` +
            `If the OAuth consent screen is still in "Testing", Google expires refresh ` +
            `tokens after 7 days — set it to "In production" and re-run ` +
            `scripts/gmail-auth.mjs to mint a new one.`,
    );
    this.name = 'GmailAuthError';
  }
}

let cached: OAuth2Client | undefined;

/**
 * Secret Manager stores bytes, and a value pasted into `firebase functions:secrets:set`
 * from a Windows terminal routinely carries a trailing CR, LF or space with it.
 *
 * None of that is visible anywhere: not in the console, not in `secrets:get`, not in the
 * paste itself. OAuth simply answers `invalid_client`, which is the same thing it says
 * when the credentials are entirely wrong — so the reader goes looking for a wrong value
 * rather than a right value with an extra byte on the end. The same credentials passed
 * on a command line work, which makes it look like the deployment is at fault.
 *
 * Trimming is safe: none of the three legitimately contains leading or trailing
 * whitespace.
 */
function secret(value: string): string {
  return value.trim();
}

function client(): OAuth2Client {
  if (!cached) {
    const id = secret(GMAIL_CLIENT_ID.value());
    const clientSecret = secret(GMAIL_CLIENT_SECRET.value());
    const refreshToken = secret(GMAIL_REFRESH_TOKEN.value());

    /**
     * What the runtime ACTUALLY loaded, once per cold start.
     *
     * `invalid_client` cannot distinguish "wrong value" from "right value, wrong
     * version pinned" from "right value with a stray byte", and every one of those
     * looks identical in the console, in `secrets:get`, and in the paste that created
     * it. Without this line the only way to tell them apart is to change something and
     * redeploy, which is a guess with a five-minute feedback loop.
     *
     * The client ID is not confidential — it travels in plain sight in every OAuth
     * consent URL — so it is logged whole. The other two are described by shape only:
     * enough to spot a truncation, a swap or an empty value, and nothing more.
     */
    logger.info('gmail: credentials loaded', {
      clientId: id,
      clientSecretChars: clientSecret.length,
      clientSecretLooksRight: clientSecret.startsWith('GOCSPX-'),
      refreshTokenChars: refreshToken.length,
      refreshTokenLooksRight: refreshToken.startsWith('1//'),
    });

    // A doubled paste is the one corruption a prefix check cannot see: GOCSPX-x…GOCSPX-x…
    // still starts with GOCSPX-, so it passes every shape test while being wrong, and
    // Google reports it as `invalid_client` — indistinguishable from a value that was
    // never right at all. Length is the only thing that separates them. Google's secrets
    // are 35 characters; anything near double that was pasted twice.
    if (clientSecret.length > 50) {
      logger.error('gmail: client secret is about twice the expected length', {
        chars: clientSecret.length,
        hint: 'A Google client secret is 35 characters. This looks like a doubled paste — re-set GMAIL_CLIENT_SECRET and redeploy.',
      });
    }

    cached = new OAuth2Client({ clientId: id, clientSecret });
    cached.setCredentials({ refresh_token: refreshToken });
  }
  return cached;
}

async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
  const query = init.params ? `?${new URLSearchParams(init.params).toString()}` : '';
  try {
    const res = await client().request<T>({
      url: `${BASE}${path}${query}`,
      method: init.method ?? 'GET',
      ...(init.body ? { data: init.body } : {}),
    });
    return res.data;
  } catch (err: unknown) {
    const message = String((err as Error)?.message ?? err);
    if (/invalid_grant|invalid_request|invalid_client|unauthorized_client/i.test(message)) {
      throw new GmailAuthError(message);
    }
    throw err;
  }
}

/**
 * The address this refresh token actually belongs to.
 *
 * Read from Gmail rather than configured, on purpose. The alias rung matches `+tag`
 * recipients against this address, so a configured value that drifted from the
 * account the token was minted for would break every alias match while everything
 * else kept working — a failure that looks like "the aliases don't work" and has
 * nothing in the logs to say why.
 */
export async function getMailbox(): Promise<string> {
  const profile = await call<{ emailAddress?: string }>('/profile');
  const address = profile.emailAddress;
  if (!address) throw new Error('Gmail profile returned no emailAddress.');
  return address.toLowerCase();
}

export interface MessagePage {
  ids: string[];
  /**
   * Gmail says there is at least one more page behind this one.
   *
   * Reported rather than followed. One page per run is deliberate — the lookback window
   * plus the cap bound each run, and a poller that falls behind catches up on the next
   * tick instead of growing unbounded inside a 9-minute timeout. But "there is more
   * waiting" has to LEAVE this function, because the state it hides is the dangerous
   * one: if the messages filling the page cannot be labelled, they refill it on every
   * run for ever and mail behind them is never reached. Silently dropping the token
   * makes a starved queue indistinguishable from an empty one.
   */
  hasMore: boolean;
}

export async function listMessageIds(query: string, maxResults: number): Promise<MessagePage> {
  const page = await call<{ messages?: { id: string }[]; nextPageToken?: string }>('/messages', {
    params: { q: query, maxResults: String(maxResults) },
  });
  return {
    ids: (page.messages ?? []).map((m) => m.id),
    hasMore: Boolean(page.nextPageToken),
  };
}

export async function getMessage(id: string): Promise<GmailMessage> {
  return call<GmailMessage>(`/messages/${id}`, { params: { format: 'full' } });
}

export async function getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const part = await call<{ data?: string; size?: number }>(
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
  if (!part.data) throw new Error(`Attachment ${attachmentId} returned no data.`);
  return Buffer.from(part.data, 'base64url');
}

interface Label {
  id: string;
  name: string;
}

let labelCache: Map<string, string> | undefined;

/** Label IDs, resolving by name and creating the label if the mailbox lacks it. */
export async function ensureLabel(name: string): Promise<string> {
  if (!labelCache) {
    const { labels = [] } = await call<{ labels?: Label[] }>('/labels');
    labelCache = new Map(labels.map((l) => [l.name, l.id]));
  }

  const existing = labelCache.get(name);
  if (existing) return existing;

  try {
    const created = await call<Label>('/labels', {
      method: 'POST',
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    labelCache.set(name, created.id);
    return created.id;
  } catch (err: unknown) {
    // A 409 means a concurrent run created it. Drop the cache and re-read rather than
    // failing the whole poll over a label.
    logger.warn('gmail: label create failed, re-reading', { name, err: String(err) });
    labelCache = undefined;
    const { labels = [] } = await call<{ labels?: Label[] }>('/labels');
    const hit = labels.find((l) => l.name === name);
    if (!hit) throw err;
    labelCache = new Map(labels.map((l) => [l.name, l.id]));
    return hit.id;
  }
}

export async function addLabel(messageId: string, labelId: string): Promise<void> {
  try {
    await call(`/messages/${messageId}/modify`, {
      method: 'POST',
      body: { addLabelIds: [labelId] },
    });
  } catch (err: unknown) {
    // Drop the cache before rethrowing. `labelCache` is a module global on a warm
    // instance, so a label deleted or renamed in Gmail leaves a dead ID here that
    // fails EVERY subsequent addLabel until the instance recycles — and an unlabelled
    // message is re-selected by the poller's query on every run for the whole lookback
    // window. That is how one deleted label starves the queue: the failing messages
    // refill the page each time and new mail is never reached.
    logger.warn('gmail: addLabel failed, dropping label cache', {
      messageId,
      labelId,
      err: String(err),
    });
    labelCache = undefined;
    throw err;
  }
}

/** Test seam: forces the next call to re-resolve labels and re-authenticate. */
export function resetGmailClient(): void {
  cached = undefined;
  labelCache = undefined;
}
