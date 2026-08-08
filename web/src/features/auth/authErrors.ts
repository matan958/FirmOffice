import { FirebaseError } from 'firebase/app';

/**
 * Firebase auth error codes → something a human can act on.
 *
 * Sign-in failures are deliberately collapsed into one message. Distinguishing
 * "no such account" from "wrong password" hands an attacker a free account-existence
 * oracle, which for a CPA firm's client list is itself sensitive. Firebase's own
 * `auth/invalid-credential` does the same thing for the same reason.
 */
const MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'That email and password do not match an account.',
  'auth/invalid-email': 'That does not look like an email address.',
  'auth/user-disabled': 'This account has been disabled. Contact the firm.',
  'auth/user-not-found': 'That email and password do not match an account.',
  'auth/wrong-password': 'That email and password do not match an account.',
  'auth/email-already-in-use': 'An account with that email already exists — sign in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/network-request-failed': 'Cannot reach the server. Check your connection.',
  // These two look alike and mean different things — worth distinguishing, because the
  // fix is a different click and the raw codes say nothing useful.
  'auth/operation-not-allowed':
    'Email/password sign-in is switched off for this project. Enable it in the Firebase ' +
    'console under Authentication → Sign-in method.',
  'auth/configuration-not-found':
    'Firebase Authentication has not been set up for this project yet. Open the Firebase ' +
    'console → Authentication → Get started, then enable Email/Password.',
};

export function authErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    return MESSAGES[err.code] ?? `${err.message} (${err.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}
