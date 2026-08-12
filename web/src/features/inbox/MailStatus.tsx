import { useState } from 'react';
import { pollGmailNowFn } from './actions';
import { minutesSinceSuccess, useIngestState } from './useIngestState';

/**
 * Mail ingestion status.
 *
 * This exists because of the failure mode the whole channel has: when Gmail ingestion
 * stops — a refresh token expired, a grant revoked, the scheduler paused — nothing
 * appears anywhere. The inbox just stops filling, which looks exactly like a quiet
 * week. Nobody investigates "no new documents" until something is late.
 *
 * So the strip states the last successful run in plain words and turns amber when that
 * gets old. A deployed monitor (M6) will alert on the same field; this is the version
 * that costs nothing and is visible to whoever is actually working the queue.
 */

/** Six missed five-minute ticks. Long enough that a slow run is not an alarm. */
const STALE_MINUTES = 30;

export default function MailStatus({ canPoll }: { canPoll: boolean }) {
  const state = useIngestState();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // A client role cannot read /ingestState, and the poller may never have run.
  if (!state) return null;

  const age = minutesSinceSuccess(state);
  const stale = age === null || age > STALE_MINUTES;

  // The other way this stops working, and the one a timestamp cannot show. Messages
  // that fail are labelled for attention and drop out of the query; messages that fail
  // BEFORE they can be labelled do not, so they refill the page on every run and mail
  // behind them is never reached. The poller keeps completing, `lastSuccessAt` keeps
  // moving, and the inbox simply stops growing.
  const starved = (state.lastRunFailures ?? 0) > 0 && state.lastRunHadMore === true;
  const alarm = stale || starved;

  async function pollNow() {
    setBusy(true);
    setResult(null);
    try {
      const res = await pollGmailNowFn();
      const d = res.data;
      setResult(
        d.ok
          ? `Checked ${d.messagesSeen} message${d.messagesSeen === 1 ? '' : 's'} · ` +
            `${d.attachmentsIngested} new · ${d.skippedDuplicates} already held` +
            (d.skippedInline > 0 ? ` · ${d.skippedInline} inline images ignored` : '') +
            (d.skippedEmpty > 0 ? ` · ${d.skippedEmpty} empty` : '') +
            (d.messagesFailed > 0 ? ` · ${d.messagesFailed} failed` : '') +
            (d.hasMore ? ' · more waiting' : '')
          : `Failed: ${d.errors[0] ?? 'unknown error'}`,
      );
    } catch (err: unknown) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs ${
        alarm ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-ink-200 text-ink-600'
      }`}
    >
      <span className="font-medium">Mail ingestion</span>

      {state.mailbox ? (
        <span className="font-mono">{state.mailbox}</span>
      ) : (
        <span>not connected yet</span>
      )}

      <span>
        {age === null
          ? '· never completed a run'
          : age < 1
            ? '· last checked just now'
            : `· last checked ${age} min ago`}
      </span>

      {starved && (
        <span className="font-medium" title="Messages are failing before they can be labelled, so they are re-read every run and newer mail is never reached.">
          · {state.lastRunFailures} failing and more waiting — mail is not getting through
        </span>
      )}

      {state.lastError && (
        <span className="max-w-md truncate" title={state.lastError}>
          · {state.lastError}
        </span>
      )}

      {canPoll && (
        <button
          onClick={() => void pollNow()}
          disabled={busy}
          className="ml-auto rounded border border-current px-2 py-0.5 disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Check now'}
        </button>
      )}

      {result && <span className="w-full text-ink-600">{result}</span>}
    </div>
  );
}
