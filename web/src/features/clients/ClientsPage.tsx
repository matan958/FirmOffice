import { useEffect, useState, type FormEvent } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { COLLECTIONS } from '@shared';
import type { ClientDoc, CreateClientRequest, CreateClientResponse } from '@shared';
import { ErrorNote, Field, SubmitButton } from '@/features/auth/AuthCard';

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
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
      <p className="mt-1 text-sm text-ink-600">
        Each client gets a permanent drop address. Give it to them — mail sent there
        files itself.
      </p>

      <NewClientForm />

      {listError && (
        <div className="mt-6">
          <ErrorNote message={listError} />
        </div>
      )}

      <div className="mt-8 overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-200 text-xs uppercase text-ink-600">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Drop address</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Client ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-200">
            {rows === null && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-ink-400">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-ink-400">
                  No clients yet — add the first one above.
                </td>
              </tr>
            )}
            {rows?.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2 font-medium">{c.name}</td>
                <td className="px-4 py-2 font-mono text-xs">docs+{c.ingestAlias}@</td>
                <td className="px-4 py-2 capitalize text-ink-600">{c.status}</td>
                <td className="px-4 py-2 font-mono text-xs break-all text-ink-400">{c.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
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
        className="mt-6 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-500"
      >
        New client
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 max-w-sm space-y-4 rounded-lg border border-ink-200 p-4">
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
        <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
          Created. Drop address:{' '}
          <code className="font-mono">docs+{created.ingestAlias}@</code>
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
