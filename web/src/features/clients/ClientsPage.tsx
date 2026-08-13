import { useEffect, useState, type FormEvent } from 'react';
import {
  collection,
  doc as docRef,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { COLLECTIONS, toTaxId } from '@shared';
import type { ClientDoc, CreateClientRequest, CreateClientResponse } from '@shared';
import { ErrorNote, Field, SubmitButton, Spinner } from '@/features/auth/AuthCard';
import { reclassifyClientFn, setClientEmailFn } from '@/features/inbox/actions';

type Row = ClientDoc & { id: string };

const createClientFn = httpsCallable<CreateClientRequest, CreateClientResponse>(
  functions,
  'createClient',
);

/**
 * Minimal client management (M2).
 *
 * Reads live via onSnapshot — the accountant rule allows it — but writes go through
 * the createClient callable, because allocating a globally unique ingest alias has to
 * be atomic and a browser cannot be trusted to do that.
 */
export default function ClientsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, COLLECTIONS.clients), orderBy('name'));
    return onSnapshot(
      q,
      (snap) => {
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ClientDoc) })));
        setListError(null);
      },
      (err) => setListError(err.message),
    );
  }, []);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
      <p className="mt-1 text-sm text-ink-600">
        A client is identified by their email address. Mail from it files itself; mail
        from anywhere else waits in Unassigned until someone files it.
      </p>

      <NewClientForm />

      {listError && (
        <div className="mt-6">
          <ErrorNote message={listError} />
        </div>
      )}

      <div className="card mt-8 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">
                  ח.פ. / ע.מ.
                  <span className="ml-1.5 normal-case tracking-normal text-ink-400">
                    decides income vs expense
                  </span>
                </th>
                <th className="px-4 py-2.5 font-medium">
                  Email
                  <span className="ml-1.5 normal-case tracking-normal text-ink-400">
                    mail from here files automatically
                  </span>
                </th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Client ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200">
              {rows === null && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-ink-400">
                    Loading…
                  </td>
                </tr>
              )}
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <p className="text-sm text-ink-600">No clients yet.</p>
                    <p className="mt-1 text-xs text-ink-400">
                      Add the first one above — a client is what documents get filed
                      against.
                    </p>
                  </td>
                </tr>
              )}
              {rows?.map((c) => (
                <tr key={c.id} className="row-hover">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3">
                    <TaxIdCell client={c} />
                  </td>
                  <td className="px-4 py-3">
                    <EmailCell client={c} />
                  </td>
                  <td className="px-4 py-3 capitalize text-ink-600">{c.status}</td>
                  <td className="px-4 py-3 font-mono text-xs break-all text-ink-400">{c.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

/**
 * The address a client's mail is recognised by, editable in place.
 *
 * This is the only thing that files a document automatically: mail from here becomes
 * this client's, and mail from anywhere else waits in Unassigned. That makes an
 * unset or mistyped address a silent fault — the client's documents simply keep
 * arriving unfiled, with nothing on screen explaining why — so it is shown in amber
 * when missing rather than left blank.
 *
 * Saving goes through the setClientEmail callable, not a direct write. Changing this is
 * three writes that have to agree (the client, the old mapping row, the new one), and
 * the new address may already belong to somebody else.
 */
function EmailCell({ client }: { client: Row }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await setClientEmailFn({ clientId: client.id, email: draft });
      const d = res.data;

      if (d.conflictWithClientId) {
        setError(
          `${draft.trim()} is already mapped to ${d.conflictWithClientName ?? d.conflictWithClientId}. ` +
            `Nothing was changed.`,
        );
        return;
      }

      setEditing(false);
      if (d.backfilled > 0) {
        setNote(`${d.backfilled} waiting document${d.backfilled === 1 ? '' : 's'} filed`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <input
          autoFocus
          type="email"
          value={draft}
          disabled={busy}
          placeholder="danny@acme.co.il"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-56 rounded-md border border-brand-400 px-2 py-1 text-sm outline-none
                     focus:ring-2 focus:ring-brand-500/25"
        />
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-brand-600 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          {busy ? <Spinner /> : 'Save'}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded-md px-1.5 py-1 text-xs text-ink-500 hover:bg-ink-100"
        >
          ✕
        </button>
        {error && <span className="w-full text-xs text-red-600">{error}</span>}
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => {
          setDraft(client.primaryContactEmail ?? '');
          setEditing(true);
          setNote(null);
        }}
        title="Click to edit"
        className={[
          'rounded-md px-2 py-1 text-sm transition-colors hover:bg-ink-100',
          client.primaryContactEmail ? 'text-ink-700' : 'text-amber-700',
        ].join(' ')}
      >
        {client.primaryContactEmail ?? 'not set — mail will not file'}
      </button>
      {note && <span className="text-xs text-emerald-700">{note}</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

/**
 * The client's own ח.פ., editable in place.
 *
 * This one number is the axle the whole income/expense classifier turns on: the ladder
 * decides direction by asking which side of a document it appears on. Until it was
 * editable, a client created without one could never be classified at all, and there
 * was no screen anywhere in the product that would let anyone fix that — the field was
 * write-once at creation and not even displayed.
 *
 * Written directly rather than through a callable. The rules already allow an accountant
 * to update /clients, and unlike creation there is no ingest alias to allocate, so there
 * is nothing here that needs to be atomic.
 *
 * Saving offers a re-classify, because the documents already in the system were decided
 * against a client record that had no ח.פ. on it. Re-deciding them costs nothing — it
 * re-runs a pure function over stored fields and never calls Gemini — but it is offered
 * rather than done, so a write touching hundreds of documents stays something a person
 * chose.
 */
function TaxIdCell({ client }: { client: Row }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerReclassify, setOfferReclassify] = useState(false);
  const [reclassified, setReclassified] = useState<string | null>(null);

  async function save() {
    const trimmed = draft.trim();
    // Normalized with the SAME function the extractor uses on the document, because the
    // two are compared for equality. A ח.פ. stored as typed — '51-436695-4' — would
    // never match '514366954' read off a scan, and nothing would report an error.
    const normalized = trimmed === '' ? null : toTaxId(trimmed);

    if (trimmed !== '' && normalized === null) {
      setError('ח.פ. is 8 or 9 digits, for example 514366954');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await updateDoc(docRef(db, COLLECTIONS.clients, client.id), {
        taxId: normalized,
        updatedAt: serverTimestamp(),
      });
      setEditing(false);
      if (normalized !== null && normalized !== client.taxId) setOfferReclassify(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reclassify() {
    setBusy(true);
    setError(null);
    try {
      const res = await reclassifyClientFn({ clientId: client.id });
      const { scanned, changed, skippedManual } = res.data;
      setReclassified(
        `${changed} of ${scanned} re-classified` +
          (skippedManual > 0 ? `, ${skippedManual} left as set by hand` : ''),
      );
      setOfferReclassify(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        <input
          autoFocus
          value={draft}
          disabled={busy}
          inputMode="numeric"
          placeholder="514366954"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-32 rounded-md border border-brand-400 px-2 py-1 font-mono text-xs outline-none
                     focus:ring-2 focus:ring-brand-500/25"
        />
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-brand-600 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          {busy ? <Spinner /> : 'Save'}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded-md px-1.5 py-1 text-xs text-ink-500 hover:bg-ink-100"
        >
          ✕
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => {
          setDraft(client.taxId ?? '');
          setEditing(true);
          setReclassified(null);
        }}
        title="Click to edit"
        className={[
          'rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-ink-100',
          client.taxId ? 'text-ink-700' : 'text-amber-700',
        ].join(' ')}
      >
        {client.taxId ?? 'not set — add it'}
      </button>

      {offerReclassify && (
        <button
          onClick={() => void reclassify()}
          disabled={busy}
          className="rounded-md bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700
                     hover:bg-brand-100 disabled:opacity-50"
        >
          {busy ? <Spinner /> : 'סווג מחדש את מסמכי הלקוח'}
        </button>
      )}

      {reclassified && <span className="text-xs text-emerald-700">{reclassified}</span>}
      {error && !editing && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

function NewClientForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [taxId, setTaxId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateClientResponse | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await createClientFn({
        name,
        taxId: taxId || undefined,
        primaryContactEmail: email || undefined,
      });
      setCreated(res.data);
      setName('');
      setEmail('');
      setTaxId('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm
                   font-medium text-white shadow-card transition-colors hover:bg-brand-500"
      >
        <span aria-hidden className="text-base leading-none">
          +
        </span>
        New client
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card mt-6 max-w-sm space-y-4 p-5">
      <Field
        label="Client name"
        required
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
      />
      <Field
        label="Primary contact email (optional)"
        type="email"
        value={email}
        disabled={busy}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Field
        label="Tax ID (optional)"
        value={taxId}
        disabled={busy}
        onChange={(e) => setTaxId(e.target.value)}
      />
      {error && <ErrorNote message={error} />}
      {created && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Created. Drop address: <code className="font-mono">+{created.ingestAlias}</code>{' '}
          — the full address is in the table below.
          {!created.emailIdentifierCreated && email && (
            <span className="mt-1 block text-xs">
              That email is already mapped to another client — mail from it will not
              auto-file here.
            </span>
          )}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton busy={busy}>Create client</SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2 text-sm text-ink-600 underline"
        >
          Close
        </button>
      </div>
    </form>
  );
}
