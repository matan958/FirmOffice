import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useSession } from '@/features/auth/AuthProvider';

/**
 * Signed-in application chrome: sidebar left, content right.
 *
 * (The original spec said "sidebar right, main left", which is the natural RTL
 * arrangement. The UI was settled as English/LTR, so this follows LTR convention —
 * see the note at the top of docs/PLAN.md. Flipping it is one `flex-row-reverse`.)
 */
export default function Shell() {
  const session = useSession();
  const { signOut } = useAuth();

  const isAccountant = session?.role === 'accountant' || session?.role === 'admin';

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-56 shrink-0 flex-col border-r border-ink-200 p-4">
        <div className="px-2 py-1 text-sm font-semibold tracking-tight">FirmOffice</div>

        <nav className="mt-6 flex flex-col gap-1">
          {isAccountant && <Item to="/inbox">Inbox</Item>}
          {isAccountant && <Item to="/clients">Clients</Item>}
          {session?.role === 'admin' && <Item to="/users">Users</Item>}
          {session?.role === 'client' && <Item to="/portal">My documents</Item>}
          <Item to="/health">System health</Item>
        </nav>

        <div className="mt-auto border-t border-ink-200 pt-4 text-xs">
          <div className="truncate px-2 font-medium" title={session?.user.email ?? ''}>
            {session?.user.displayName || session?.user.email}
          </div>
          <div className="px-2 text-ink-400 capitalize">{session?.role ?? 'no role'}</div>
          <button
            onClick={() => void signOut()}
            className="mt-2 px-2 text-brand-600 underline"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function Item({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          'rounded-md px-2 py-1.5 text-sm',
          isActive ? 'bg-brand-600 text-white' : 'text-ink-600 hover:bg-ink-100',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  );
}
