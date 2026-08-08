import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { homeFor } from './guards';
import { authErrorMessage } from './authErrors';
import { AuthCard, ErrorNote, Field, SubmitButton } from './AuthCard';

/**
 * Client self-signup.
 *
 * This creates an account, nothing more. The new user gets `role: 'client'` with NO
 * clientId, which the security rules treat as "may see nothing" — an accountant links
 * them to a client record before they can upload. That ordering is the point: signup
 * is open to the internet, so it must not be able to grant access to anyone's files.
 *
 * Accountants never come through here; they are created by an admin via setUserRole.
 */
export default function SignupPage() {
  const { state, signUp } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'ready') return <Navigate to={homeFor(state.session)} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signUp(email.trim(), password, displayName);
    } catch (err: unknown) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="For clients of the firm"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-brand-600 underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Your name"
          type="text"
          autoComplete="name"
          required
          value={displayName}
          disabled={busy}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorNote message={error} />}
        <SubmitButton busy={busy}>Create account</SubmitButton>
      </form>
    </AuthCard>
  );
}
