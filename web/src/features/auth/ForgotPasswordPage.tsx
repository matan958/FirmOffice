import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { authErrorMessage } from './authErrors';
import { AuthCard, ErrorNote, Field, SubmitButton } from './AuthCard';

/**
 * Password reset.
 *
 * ── Why the result is always the same ──
 * The success message does not say whether an account exists for that address. It is
 * tempting to be helpful — "no account with that email" — but that turns this form
 * into an oracle for checking whether a given person banks with this firm, and a
 * client list is exactly the sort of thing a CPA firm is obliged to keep private. The
 * sign-in form collapses its failures for the same reason.
 *
 * `auth/user-not-found` is therefore swallowed rather than shown. Everything else —
 * a malformed address, rate limiting, no network — is still reported, because those
 * are the caller's own problem to fix and reveal nothing about anyone else.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setSent(true);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/user-not-found' || code === 'auth/invalid-credential') {
        setSent(true); // See the note above — do not confirm or deny.
      } else {
        setError(authErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="If an account exists for that address, a reset link is on its way."
        footer={
          <Link to="/login" className="text-brand-700 underline">
            Back to sign in
          </Link>
        }
      >
        <div className="space-y-3 text-sm text-ink-600">
          <p>
            The link expires in an hour. If it does not arrive within a few minutes,
            check spam — the sender is <span className="font-mono text-xs">noreply@</span>
            your project's domain, which some mail servers filter.
          </p>
          <button
            onClick={() => {
              setSent(false);
              setError(null);
            }}
            className="text-brand-700 underline"
          >
            Use a different address
          </button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We will email you a link to choose a new one."
      footer={
        <Link to="/login" className="text-brand-700 underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
        {error && <ErrorNote message={error} />}
        <SubmitButton busy={busy}>Send reset link</SubmitButton>
      </form>
    </AuthCard>
  );
}
