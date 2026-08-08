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
    super(
      `Gmail refused the stored refresh token (${cause}). The token is revoked or ` +
        `expired. If the OAuth consent screen is still in "Testing", Google expires ` +
        `refresh tokens after 7 days — set it to "In production" and re-run ` +
        `scripts/gmail-auth.mjs to mint a new one.`,
    );
    this.name = 'GmailAuthError';
  }
}

let cached: OAuth2Client | undefined;

function client(): OAuth2Client {
  if (!cached) {
    cached = new OAuth2Client({
      clientId: GMAIL_CLIENT_ID.value(),
      clientSecret: GMAIL_CLIENT_SECRET.value(),
    });
    cached.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN.value() });
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
    if (/invalid_grant|invalid_request|unauthorized_client/i.test(message)) {
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

export async function listMessageIds(query: string, maxResults: number): Promise<string[]> {
  const page = await call<{ messages?: { id: string }[] }>('/messages', {
    params: { q: query, maxResults: String(maxResults) },
  });
  // Deliberately one page only. The lookback window plus the cap bound each run, and
  // a run that falls behind catches up on the next tick rather than growing unbounded
  // inside a single 9-minute function timeout.
  return (page.messages ?? []).map((m) => m.id);
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
  await call(`/messages/${messageId}/modify`, {
    method: 'POST',
    body: { addLabelIds: [labelId] },
  });
}

/** Test seam: forces the next call to re-resolve labels and re-authenticate. */
export function resetGmailClient(): void {
  cached = undefined;
  labelCache = undefined;
}
