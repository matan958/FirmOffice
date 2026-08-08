import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import type { Role } from '@shared';
import type { Session } from './AuthProvider';

/**
 * Route guards.
 *
 * These are a UX affordance, not the security boundary — a determined user can edit
 * their own JavaScript. Enforcement lives in firestore.rules and storage.rules, which
 * read the same claims from a token they verify server-side. A guard's job is to stop
 * an accountant from staring at an empty Client Portal, nothing more.
 */

/** Where a given role belongs when they land on "/" or hit a page they may not see. */
export function homeFor(session: Session | undefined): string {
  if (!session || session.role === null) return '/pending';
  if (session.role === 'client') return session.pending ? '/pending' : '/portal';
  return '/inbox';
}

function Splash({ label }: { label: string }) {
  return (
    <main className="grid min-h-dvh place-items-center p-8">
      <p className="text-sm text-ink-600" role="status">
        {label}
      </p>
    </main>
  );
}

/** Requires a signed-in user. Anything else bounces to /login. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') return <Splash label="Loading…" />;
  if (state.status === 'provisioning') return <Splash label="Setting up your account…" />;

  if (state.status === 'error') {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-ink-600">{state.message}</p>
      </main>
    );
  }

  if (state.status === 'signedOut') {
    // Remember where they were headed so login can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

/**
 * Requires one of `allow`. Assumes RequireAuth ran first, so by here the state is
 * either ready or still settling.
 */
export function RequireRole({ allow }: { allow: readonly Role[] }) {
  const { state } = useAuth();

  if (state.status !== 'ready') return <Splash label="Loading…" />;

  const { session } = state;
  if (session.role === null || !allow.includes(session.role)) {
    return <Navigate to={homeFor(session)} replace />;
  }
  // A client with no clientId claim can read nothing, so send them to the holding
  // page rather than an upload form that would fail on every write.
  if (session.pending) {
    return <Navigate to="/pending" replace />;
  }
  return <Outlet />;
}

/** "/" — send each role to the surface that is actually theirs. */
export function RoleLanding() {
  const { state } = useAuth();
  if (state.status === 'loading' || state.status === 'provisioning') {
    return <Splash label="Loading…" />;
  }
  if (state.status !== 'ready') return <Navigate to="/login" replace />;
  return <Navigate to={homeFor(state.session)} replace />;
}
