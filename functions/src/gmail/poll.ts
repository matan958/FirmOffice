import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { requireAdmin } from '../lib/auth.js';
import type { ServerWrite } from '../lib/model.js';
import { ingestDocument } from '../ingest/ingestDocument.js';
import { resolveClient, type IdentifierLookup } from '../mapping/resolveClient.js';
import { headerAll, header, parseAddress, parseAddressList, parseAuthResults } from '../mapping/headers.js';
import { plainTextBody, scanAttachments, type GmailMessage } from './parts.js';
import {
  GMAIL_SECRETS,
  addLabel,
  ensureLabel,
  getAttachment,
  getMailbox,
  getMessage,
  listMessageIds,
} from './api.js';
import {
  COLLECTIONS,
  GMAIL_ATTENTION_LABEL,
  GMAIL_LOOKBACK_DAYS,
  GMAIL_MAX_MESSAGES_PER_RUN,
  GMAIL_PROCESSED_LABEL,
} from '../shared.js';
import type {
  ClientDoc,
  ClientIdentifierDoc,
  FailedIngestionDoc,
  GmailSource,
  IngestStateDoc,
  PollGmailResponse,
} from '../shared.js';

/**
 * The Gmail poller.
 *
 * ── Why polling, and why stateless ──
 * Gmail's push alternative (users.watch + Pub/Sub) needs a subscription that EXPIRES
 * EVERY 7 DAYS and a daily renewal function to survive, plus history-cursor handling
 * with a fallback scan for when Gmail's ~1 week of history has aged out. That is a lot
 * of moving parts whose failure mode is silence. This polls a fixed lookback window
 * instead and keeps no cursor: every run re-reads the last two days and the
 * idempotency ledger discards what it already holds, so any outage shorter than the
 * window self-heals with nothing to reconcile. The cost is latency measured in
 * minutes, which for accounting paperwork is not a cost.
 *
 * ── Failure containment ──
 * One malformed message must not stall ingestion for the firm. Every message is
 * processed in its own try/catch; failures land in /failedIngestions and get labelled
 * for a human, and the run continues.
 */

const QUERY = [
  'has:attachment',
  `newer_than:${GMAIL_LOOKBACK_DAYS}d`,
  `-label:${GMAIL_PROCESSED_LABEL}`,
  `-label:${GMAIL_ATTENTION_LABEL}`,
].join(' ');

const STATE_REF = () => db().doc(`${COLLECTIONS.ingestState}/gmail`);

/** Reads an identifier and records the hit, so the mapping table shows what earns its keep. */
const identifierLookup: IdentifierLookup = async (key) => {
  const snap = await db().doc(`${COLLECTIONS.clientIdentifiers}/${key}`).get();
  if (!snap.exists) return null;

  // Fire-and-forget: a failed statistics update must never fail an ingest.
  void snap.ref
    .update({ lastMatchedAt: FieldValue.serverTimestamp(), matchCount: FieldValue.increment(1) })
    .catch(() => undefined);

  return snap.data() as ClientIdentifierDoc;
};

async function clientName(clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const snap = await db().doc(`${COLLECTIONS.clients}/${clientId}`).get();
  return snap.exists ? ((snap.data() as ClientDoc).name ?? null) : null;
}

interface RunTotals {
  messagesSeen: number;
  attachmentsIngested: number;
  skippedDuplicates: number;
  skippedInline: number;
  errors: string[];
}

async function processMessage(
  message: GmailMessage,
  mailbox: string,
  totals: RunTotals,
): Promise<{ needsAttention: boolean }> {
  const headers = message.payload?.headers ?? [];

  const from = parseAddress(header(headers, 'From'));
  const recipients = [
    ...parseAddressList(header(headers, 'To')),
    ...parseAddressList(header(headers, 'Cc')),
    // Delivered-To / X-Original-To carry the address the message actually reached,
    // which is what survives a mailing list or a Gmail forwarding rule rewriting To:.
    ...parseAddressList(header(headers, 'Delivered-To')),
    ...parseAddressList(header(headers, 'X-Original-To')),
  ];
  const subject = header(headers, 'Subject') ?? '';

  const auth = parseAuthResults(headerAll(headers, 'Authentication-Results'));
  const scan = scanAttachments(message);

  const resolution = await resolveClient(
    {
      from,
      recipients: [...new Set(recipients)],
      replyTo: parseAddress(header(headers, 'Reply-To')),
      subject,
      bodyText: plainTextBody(message),
      auth,
    },
    identifierLookup,
    { ingestMailbox: mailbox },
  );

  const name = await clientName(resolution.clientId);

  // Gmail's own receipt time, NOT the sender-supplied `Date:` header. The plan called
  // for the Date header as "when the client sent it", but that field is written by the
  // sender's machine: a skewed clock or a spam sender dates a message in 2030 and pins
  // it to the top of an inbox sorted by receivedAt, permanently. internalDate is the
  // closest honest answer that cannot be forged.
  const receivedAt = message.internalDate
    ? new Date(Number(message.internalDate))
    : new Date();

  totals.skippedInline += scan.skipped.filter((s) => s.reason === 'inline-image').length;

  for (const attachment of scan.attachments) {
    const bytes = attachment.attachmentId
      ? await getAttachment(message.id, attachment.attachmentId)
      : Buffer.from(attachment.inlineData ?? '', 'base64url');

    if (bytes.length === 0) continue;

    const source: GmailSource = {
      messageId: message.id,
      threadId: message.threadId,
      from: from ?? '',
      subject,
      // Recorded for traceability only. The idempotency key uses the part INDEX,
      // because Gmail does not guarantee attachmentId is stable across fetches.
      attachmentId: attachment.attachmentId ?? '',
      toAlias: resolution.aliasTag,
      dkimPass: auth.dkimPass,
      spfPass: auth.spfPass,
    };

    const outcome = await ingestDocument({
      bytes,
      originalName: attachment.filename,
      contentType: attachment.mimeType,
      channel: 'gmail',
      source,
      receivedAt,
      clientId: resolution.clientId,
      clientName: name,
      clientMatch: {
        method: resolution.method,
        confidence: resolution.confidence,
        matchedIdentifier: resolution.matchedIdentifier,
        suggestedClientId: resolution.suggestedClientId,
        suggestedClientName: await clientName(resolution.suggestedClientId),
        authDowngraded: resolution.authDowngraded,
      },
      externalId: `${message.id}.${attachment.index}`,
    });

    if (outcome.status === 'ingested') totals.attachmentsIngested++;
    else totals.skippedDuplicates++;
  }

  if (scan.driveLinks.length > 0) {
    logger.warn('gmail: message carries Drive links we cannot fetch', {
      messageId: message.id,
      links: scan.driveLinks.length,
    });
  }

  return { needsAttention: scan.needsAttention };
}

async function recordFailure(messageId: string, err: unknown): Promise<void> {
  const failure: ServerWrite<FailedIngestionDoc> = {
    channel: 'gmail',
    externalId: messageId,
    reason: String(err),
    payload: { messageId },
    attempts: 1,
    at: FieldValue.serverTimestamp(),
  };
  await db()
    .collection(COLLECTIONS.failedIngestions)
    .doc(`gmail:${messageId}`)
    .set(failure, { merge: true })
    .catch(() => undefined);
}

export async function runPoll(): Promise<PollGmailResponse> {
  const totals: RunTotals = {
    messagesSeen: 0,
    attachmentsIngested: 0,
    skippedDuplicates: 0,
    skippedInline: 0,
    errors: [],
  };

  await STATE_REF().set({ lastPollAt: FieldValue.serverTimestamp() }, { merge: true });

  try {
    const mailbox = await getMailbox();
    const [processedLabel, attentionLabel] = await Promise.all([
      ensureLabel(GMAIL_PROCESSED_LABEL),
      ensureLabel(GMAIL_ATTENTION_LABEL),
    ]);

    const ids = await listMessageIds(QUERY, GMAIL_MAX_MESSAGES_PER_RUN);
    logger.info('gmail poll: starting', { mailbox, candidates: ids.length });

    for (const id of ids) {
      try {
        const message = await getMessage(id);
        totals.messagesSeen++;

        // Defence in depth. If the `-label:` exclusion in QUERY ever silently stops
        // matching — a renamed label, a quoting change — the ledger still prevents
        // duplicate documents, but this stops us re-downloading the window every run.
        const labels = message.labelIds ?? [];
        if (labels.includes(processedLabel) || labels.includes(attentionLabel)) continue;

        const { needsAttention } = await processMessage(message, mailbox, totals);

        // Labelled only after every attachment is safely stored, so a crash mid-message
        // leaves the message unlabelled and the next run retries it.
        await addLabel(id, needsAttention ? attentionLabel : processedLabel);
      } catch (err: unknown) {
        // One bad message must not stall ingestion for the firm.
        logger.error('gmail poll: message failed', { messageId: id, err: String(err) });
        totals.errors.push(`${id}: ${String(err)}`);
        await recordFailure(id, err);
        await addLabel(id, attentionLabel).catch(() => undefined);
      }
    }

    const state: Partial<ServerWrite<IngestStateDoc>> = {
      lastSuccessAt: FieldValue.serverTimestamp(),
      lastError: totals.errors.length > 0 ? totals.errors[0]! : null,
      consecutiveFailures: 0,
      totalIngested: FieldValue.increment(totals.attachmentsIngested),
    };
    await STATE_REF().set(state, { merge: true });

    logger.info('gmail poll: done', totals);
    return { ok: true, ...totals };
  } catch (err: unknown) {
    // A whole-run failure: bad credentials, Gmail unreachable, quota. Recorded on the
    // state document because this is what the M6 silent-failure alarm reads — an
    // ingestion pipeline that has stopped looks exactly like a quiet week otherwise.
    logger.error('gmail poll: run failed', { err: String(err) });
    await STATE_REF()
      .set(
        {
          lastError: String(err),
          consecutiveFailures: FieldValue.increment(1),
        },
        { merge: true },
      )
      .catch(() => undefined);
    return { ok: false, ...totals, errors: [...totals.errors, String(err)] };
  }
}

/**
 * `retryCount: 0` is deliberate: a failed run must NOT be retried by the scheduler.
 * The next tick five minutes later re-reads the same window anyway, so a retry adds
 * concurrency against the same messages for no coverage — and concurrent runs are
 * exactly what the idempotency ledger has to work hardest to survive.
 */
export const pollGmail = onSchedule(
  {
    schedule: `every 5 minutes`,
    secrets: GMAIL_SECRETS,
    timeoutSeconds: 540,
    memory: '1GiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    await runPoll();
  },
);

/** Manual trigger, so the poller can be exercised without waiting for a tick. */
export const pollGmailNow = onCall<void, Promise<PollGmailResponse>>(
  { secrets: GMAIL_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    requireAdmin(request);
    return runPoll();
  },
);
