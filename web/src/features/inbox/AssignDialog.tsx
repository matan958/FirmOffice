import { useMemo, useState } from 'react';
import { ErrorNote } from '@/features/auth/AuthCard';
import { PUBLIC_EMAIL_DOMAINS, normalizeEmail } from '@shared';
import type { GmailSource } from '@shared';
import { assignClient, linkIdentifierFn } from './actions';
import type { DocRow } from './useDocuments';

/**
 * Filing an unassigned document — and, in the same gesture, teaching the ladder.
 *
 * The checkbox is the whole point of this dialog. Without it the Unassigned queue is a
 * permanent tax: the same sender's mail lands there every month forever and someone
 * files it by hand every month forever. With it, each manual decision is the last one
 * needed for that sender, and the queue shrinks to genuinely new correspondents.
 *
 * It is opt-in rather than automatic because a sender is not always a client. Mail
 * from a bank, an accountant's own colleague, or a marketplace that emails on a
 * client's behalf should be filed once without minting a rule that then swallows
 * everything else from that address.
 */

interface Props {
  doc: DocRow;
  clients: { id: string; name: string }[];
  actorUid: string;
  onClose(): void;
}

type Rule = 'none' | 'email' | 'domain';

export default function AssignDialog({ doc, clients, actorUid, onClose }: Props) {
  const sender = useMemo(() => {
    if (doc.channel !== 'gmail') return null;
    const from = (doc.source as GmailSource).from;
    return from ? normalizeEmail(from) : null;
  }, [doc]);

  const domain = sender?.slice(sender.indexOf('@') + 1) ?? null;
  // A domain rule over a public provider would map every one of its users to this
  // client, so it is not offered at all. The server refuses it too — this just avoids
  // presenting a choice that can only end in an error message.
  const domainOffered = Boolean(domain) && !PUBLIC_EMAIL_DOMAINS.has(domain!);

  const suggested = doc.clientMatch?.suggestedClientId ?? null;

  const [clientId, setClientId] = useState(suggested ?? '');
  const [rule, setRule] = useState<Rule>(sender ? 'email' : 'none');
  const [backfill, setBackfill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';

  async function submit() {
    if (!clientId) return;
    setBusy(true);
    setError(null);
    setConflict(null);

    try {
      // File first. If the rule write fails — a conflicting identifier, a permissions
      // problem — the document is still filed, which is the part the accountant
      // actually asked for. The reverse order risks the opposite.
      await assignClient(doc.id, clientId, clientName, actorUid);

      if (rule !== 'none' && sender) {
        const res = await linkIdentifierFn({
          type: rule,
          value: rule === 'domain' ? domain! : sender,
          clientId,
          backfill,
        });
        if (res.data.conflictWithClientId) {
          const owner = clients.find((c) => c.id === res.data.conflictWithClientId)?.name;
          setConflict(
            `This document was filed, but the rule was not created: ` +
              `${rule === 'domain' ? domain : sender} is already mapped to ` +
              `${owner ?? 'another client'}.`,
          );
          setBusy(false);
          return;
        }
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">File this document</h2>
        <p className="mt-1 truncate text-sm text-ink-600">{doc.file.originalName}</p>

        {sender && (
          <p className="mt-1 text-xs text-ink-400">
            from <span className="font-mono">{sender}</span>
            {doc.clientMatch?.authDowngraded && (
              <span
                className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-900"
                title="The receiving server could not confirm this sender is who the message claims."
              >
                unverified sender
              </span>
            )}
          </p>
        )}

        {suggested && (
          <p className="mt-3 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-900">
            The ladder found a likely match but was not confident enough to file it
            automatically
            {doc.clientMatch?.suggestedClientName
              ? ` — ${doc.clientMatch.suggestedClientName}`
              : ''}
            . It is pre-selected below.
          </p>
        )}

        <label className="mt-4 block text-sm">
          <span className="text-ink-600">Client</span>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="mt-1 w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {sender && (
          <fieldset className="mt-4 space-y-2 text-sm">
            <legend className="text-ink-600">In future</legend>

            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="rule"
                checked={rule === 'email'}
                onChange={() => setRule('email')}
                className="mt-1"
              />
              <span>
                Always file mail from <span className="font-mono text-xs">{sender}</span>
                {clientName && <> under <strong>{clientName}</strong></>}
              </span>
            </label>

            {domainOffered && (
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="rule"
                  checked={rule === 'domain'}
                  onChange={() => setRule('domain')}
                  className="mt-1"
                />
                <span>
                  Always file mail from anyone at{' '}
                  <span className="font-mono text-xs">{domain}</span>
                  <span className="block text-xs text-ink-400">
                    For a client whose staff mail from several addresses. Matches at
                    lower confidence, so it still shows a verify prompt.
                  </span>
                </span>
              </label>
            )}

            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="rule"
                checked={rule === 'none'}
                onChange={() => setRule('none')}
                className="mt-1"
              />
              <span>
                Just this one
                <span className="block text-xs text-ink-400">
                  For a bank, a marketplace, or anyone who mails on a client's behalf.
                </span>
              </span>
            </label>

            {rule !== 'none' && (
              <label className="mt-2 flex items-center gap-2 border-t border-ink-200 pt-3">
                <input
                  type="checkbox"
                  checked={backfill}
                  onChange={(e) => setBackfill(e.target.checked)}
                />
                <span className="text-xs text-ink-600">
                  Also re-file documents already waiting from this sender
                </span>
              </label>
            )}
          </fieldset>
        )}

        {conflict && (
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{conflict}</p>
        )}
        {error && (
          <div className="mt-4">
            <ErrorNote message={error} />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-ink-200 px-3 py-1.5 text-sm"
          >
            {conflict ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !clientId}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Filing…' : 'File'}
          </button>
        </div>
      </div>
    </div>
  );
}
