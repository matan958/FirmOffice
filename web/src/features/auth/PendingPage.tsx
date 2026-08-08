import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { homeFor } from './guards';
import { AuthCard, SubmitButton } from './AuthCard';

/**
 * Holding page for a signed-up client the firm has not linked to a client record yet.
 *
 * Their token carries `role: 'client'` with no clientId, so every read and write is
 * denied by the rules. Showing this instead of a portal that fails on contact is the
 * difference between "waiting on the firm" and "the app is broken".
 *
 * The account ID is surfaced deliberately: it is what an administrator needs to run
 * setUserRole, and asking a user to read it off a screen beats hunting the Auth
 * console for an email address.
 */
export default function PendingPage() {
  const { state, refresh, signOut } = useAuth();
  const [checking, setChecking] = useState(false);

  if (state.status !== 'ready') return null;
  const { session } = state;

  // Already linked (or an accountant landed here by accident) — send them home.
  if (!session.pending) return <Navigate to={homeFor(session)} replace />;

  async function onCheck() {
    setChecking(true);
    try {
      // Pulls a fresh token; if an accountant linked them meanwhile, the clientId
      // claim arrives and the provider re-renders us straight out of this page.
      await refresh();
    } finally {
      setChecking(false);
    }
  }

  return (
    <AuthCard
      title="Account awaiting activation"
      subtitle="Your account exists, but the firm has not linked it to a client file yet."
      footer={
        <button onClick={() => void signOut()} className="text-brand-600 underline">
          Sign out
        </button>
      }
    >
      <div className="space-y-4">
        <dl className="divide-y divide-ink-200 rounded-lg border border-ink-200 text-sm">
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="font-medium text-ink-600">Signed in as</dt>
            <dd className="font-mono">{session.user.email}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="font-medium text-ink-600">Account ID</dt>
            <dd className="font-mono text-xs break-all">{session.user.uid}</dd>
          </div>
        </dl>

        <p className="text-sm text-ink-600">
          Contact the firm and give them the account ID above. Once they activate you,
          check again.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onCheck();
          }}
        >
          <SubmitButton busy={checking}>Check again</SubmitButton>
        </form>
      </div>
    </AuthCard>
  );
}
