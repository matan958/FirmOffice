import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useSession } from '@/features/auth/AuthProvider';

/**
 * Signed-in application chrome: sidebar left, content right.
 *
 * (The original spec said "sidebar right, main left", which is the natural RTL
 * arrangement. The UI was settled as English/LTR, so this follows LTR convention —
 * see the note at the top of docs/PLAN.md. Flipping it is one `flex-row-reverse`.)
 *
 * The sidebar is fixed-height with its own scroll, so the document viewer — which
 * fills the viewport and scrolls two panes independently — cannot push the navigation
 * off screen.
 */
export default function Shell() {
  const session = useSession();
  const { signOut } = useAuth();

  const isAccountant = session?.role === 'accountant' || session?.role === 'admin';
  const name = session?.user.displayName || session?.user.email || '';

  return (
    <div className="flex h-dvh">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-200 bg-white">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">FirmOffice</span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
          {isAccountant && (
            <>
              <Group>Firm</Group>
              <Item to="/inbox" icon={<InboxIcon />}>
                Inbox
              </Item>
              <Item to="/clients" icon={<ClientsIcon />}>
                Clients
              </Item>
            </>
          )}

          {session?.role === 'client' && (
            <>
              <Group>My account</Group>
              <Item to="/portal" icon={<UploadIcon />}>
                My documents
              </Item>
            </>
          )}

          {session?.role === 'admin' && (
            <>
              <Group>Administration</Group>
              <Item to="/users" icon={<UsersIcon />}>
                Users
              </Item>
            </>
          )}

          <Group>System</Group>
          <Item to="/health" icon={<PulseIcon />}>
            Health
          </Item>
        </nav>

        <div className="border-t border-ink-200 p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span
              className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700"
              aria-hidden
            >
              {initials(name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium" title={name}>
                {name}
              </span>
              <span className="block text-[11px] capitalize text-ink-400">
                {session?.role ?? 'no role'}
              </span>
            </span>
          </div>
          <button
            onClick={() => void signOut()}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-ink-600 transition-colors hover:bg-ink-100"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* min-w-0 so a wide table scrolls inside the pane instead of stretching it. */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase();
}

function Group({ children }: { children: string }) {
  return (
    <div className="mt-4 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
      {children}
    </div>
  );
}

function Item({
  to,
  icon,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  children: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors',
          isActive
            ? 'bg-brand-50 font-medium text-brand-700'
            : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
        ].join(' ')
      }
    >
      <span className="shrink-0 text-current" aria-hidden>
        {icon}
      </span>
      {children}
    </NavLink>
  );
}

/* Inline SVGs rather than an icon package: five icons is not worth a dependency, and
   they inherit currentColor so the active state needs no separate treatment. */

const stroke = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Mark() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-600 text-white">
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M6 3.5h7.5L18.5 8.5V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
        <path d="M13 3.5V9h5.5M8.5 13h7M8.5 16.5h4.5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      </svg>
    </span>
  );
}

function InboxIcon() {
  return (
    <svg {...stroke}>
      <path d="M3 13h4l1.5 3h7L17 13h4" />
      <path d="M4.5 6.5 3 13v5.5h18V13l-1.5-6.5a1.5 1.5 0 0 0-1.45-1.1H5.95A1.5 1.5 0 0 0 4.5 6.5Z" />
    </svg>
  );
}

function ClientsIcon() {
  return (
    <svg {...stroke}>
      <path d="M3.5 20.5V6.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v14M12.5 10.5h7a1 1 0 0 1 1 1v9" />
      <path d="M2 20.5h20M6.5 9h2.5M6.5 12.5h2.5M6.5 16h2.5M16 14h1.5M16 17.5h1.5" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg {...stroke}>
      <path d="M12 15.5V4m0 0L8 8m4-4 4 4" />
      <path d="M3.5 15v3.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V15" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg {...stroke}>
      <circle cx={9} cy={8} r={3.2} />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16.5 5.2a3.2 3.2 0 0 1 0 6.1M18 20a6.5 6.5 0 0 0-2.2-4.9" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg {...stroke}>
      <path d="M2.5 12h4l2.5-6 4 12 2.5-6h4" />
    </svg>
  );
}
