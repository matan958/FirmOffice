import { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/lib/firebase';
import { useSession } from '@/features/auth/AuthProvider';
import { COLLECTIONS } from '@shared';
import type { ClientDoc, Role, SetUserRoleRequest, SetUserRoleResponse, UserDoc } from '@shared';
import { ErrorNote } from '@/features/auth/AuthCard';

type UserRow = UserDoc & { id: string };
type ClientRow = { id: string; name: string };

const setUserRoleFn = httpsCallable<SetUserRoleRequest, SetUserRoleResponse>(
  functions,
  'setUserRole',
);

/**
 * Admin-only user management.
 *
 * This is what makes a self-registered client usable: signup leaves them with
 * `role: 'client'` and no clientId, which the rules treat as "may see nothing". Until
 * someone links them here, they sit on /pending. Accountants are also created here —
 * there is deliberately no self-signup path to that role.
 */
export default function UsersPage() {
  const session = useSession();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, COLLECTIONS.users), orderBy('email')),
      (snap) => setUsers(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) }))),
      (err) => setError(err.message),
    );
  }, []);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, COLLECTIONS.clients), orderBy('name')),
      (snap) =>
        setClients(snap.docs.map((d) => ({ id: d.id, name: (d.data() as ClientDoc).name }))),
      (err) => setError(err.message),
    );
  }, []);

  const pending = users?.filter((u) => u.role === 'client' && !u.clientId) ?? [];

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <p className="mt-1 text-sm text-ink-600">
        Roles live in the ID token. Changing one revokes the user&apos;s refresh tokens,
        so it takes effect on their next request rather than in up to an hour.
      </p>

      {error && (
        <div className="mt-6">
          <ErrorNote message={error} />
        </div>
      )}

      {pending.length > 0 && (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {pending.length} account{pending.length === 1 ? '' : 's'} awaiting activation.
          {clients.length === 0 && ' Create a client first — there is nothing to link to yet.'}
        </p>
      )}

      <div className="card mt-6 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Email</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Linked client</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-200">
            {users === null && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-ink-400">
                  Loading…
                </td>
              </tr>
            )}
            {users?.map((u) => (
              <UserRowView key={u.id} user={u} clients={clients} selfUid={session?.user.uid} />
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function UserRowView({
  user,
  clients,
  selfUid,
}: {
  user: UserRow;
  clients: ClientRow[];
  selfUid: string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');

  const isPending = user.role === 'client' && !user.clientId;
  // setUserRole refuses to change the caller's own role — an admin who demoted
  // themselves could not undo it. Don't offer a button that can only fail.
  const isSelf = user.id === selfUid;

  async function apply(role: Role, clientId?: string) {
    setBusy(true);
    setError(null);
    try {
      await setUserRoleFn({ uid: user.id, role, clientId });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={isPending ? 'bg-amber-50/50' : undefined}>
      <td className="px-4 py-2">
        <div className="font-medium">{user.email}</div>
        <div className="font-mono text-xs text-ink-400">{user.id}</div>
      </td>
      <td className="px-4 py-2 capitalize">{user.role}</td>
      <td className="px-4 py-2 text-ink-600">
        {user.clientId ? (
          clients.find((c) => c.id === user.clientId)?.name ?? user.clientId
        ) : user.role === 'client' ? (
          <span className="text-amber-700">not linked</span>
        ) : (
          // Accountants and admins see every client by role; a link would mean nothing,
          // and flagging them amber implies something is wrong when nothing is.
          <span className="text-ink-400">—</span>
        )}
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {isSelf && <span className="text-xs text-ink-400">you</span>}
          {!isSelf && user.role === 'client' && (
            <>
              <select
                value={choice}
                disabled={busy || clients.length === 0}
                onChange={(e) => setChoice(e.target.value)}
                className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs"
              >
                <option value="">Link to client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                disabled={busy || !choice}
                onClick={() => void apply('client', choice)}
                className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
              >
                Link
              </button>
            </>
          )}
          {!isSelf && user.role !== 'accountant' && (
            <button
              disabled={busy}
              onClick={() => void apply('accountant')}
              className="rounded-md border border-ink-200 px-2 py-1 text-xs disabled:opacity-40"
            >
              Make accountant
            </button>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
    </tr>
  );
}
