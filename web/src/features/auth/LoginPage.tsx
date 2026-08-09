import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { homeFor } from './guards';
import { authErrorMessage } from './authErrors';
import { AuthCard, ErrorNote, Field, SubmitButton } from './AuthCard';

/**
 * Email/password sign-in. There is no role picker: the role comes from the ID token's
 * custom claims, not from anything the user tells us. A form that asked "are you a
 * client or an accountant?" would be theatre — the answer could not be trusted and
 * the server ignores it anyway.
 */
export default function LoginPage() {
  const { state, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'ready') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? homeFor(state.session)} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      // No navigate() here — the redirect above fires once the listener reports ready.
    } catch (err: unknown) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Sign in to FirmOffice"
      subtitle="Document portal"
      footer={
        <>
          New client?{' '}
          <Link to="/signup" className="text-brand-600 underline">
            Create an account
          </Link>
          <span className="mt-2 block text-xs text-ink-400">
            Accountants are added by the firm — ask an administrator for access.
          </span>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div>
          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Link
            to="/forgot-password"
            className="mt-1.5 inline-block text-xs text-ink-500 underline-offset-2 hover:text-brand-700 hover:underline"
          >
            Forgot your password?
          </Link>
        </div>
        {error && <ErrorNote message={error} />}
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
    </AuthCard>
  );
}
