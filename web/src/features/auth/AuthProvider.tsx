import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '@/lib/firebase';
import type { RegisterClientResponse, Role } from '@shared';

/**
 * Session state derived from the ID token's custom claims.
 *
 * The claims are the authorization source of truth — the same thing the security
 * rules read. This provider never consults the /users document to decide what someone
 * may do, because that document is a display mirror and can lag the token.
 */
export interface Session {
  user: User;
  role: Role | null;
  clientId: string | null;
  /** A client who signed up but has not been linked to a /clients record yet. */
  pending: boolean;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  /** Signed in with a role-less token; registerClient is in flight. */
  | { status: 'provisioning' }
  | { status: 'ready'; session: Session }
  | { status: 'error'; message: string };

interface AuthContextValue {
  state: AuthState;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, displayName: string): Promise<void>;
  signOut(): Promise<void>;
  /** Force a token refresh — call after a role change so new claims land at once. */
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Convenience for the common case; undefined while loading or signed out. */
export function useSession(): Session | undefined {
  const { state } = useAuth();
  return state.status === 'ready' ? state.session : undefined;
}

const registerClientFn = httpsCallable<void, RegisterClientResponse>(functions, 'registerClient');

function sessionFrom(user: User, claims: Record<string, unknown>): Session {
  const rawRole = claims['role'];
  const rawClientId = claims['clientId'];
  const role =
    rawRole === 'client' || rawRole === 'accountant' || rawRole === 'admin' ? rawRole : null;
  const clientId = typeof rawClientId === 'string' && rawClientId.length > 0 ? rawClientId : null;
  return { user, role, clientId, pending: role === 'client' && clientId === null };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  // Which uids we have already tried to provision. Without this, a registerClient
  // that legitimately returns no role (or fails) would retrigger onIdTokenChanged and
  // spin forever — and StrictMode's double-invoked effects would double every call.
  const provisioned = useRef<Set<string>>(new Set());

  useEffect(() => {
    // onIdTokenChanged, NOT onAuthStateChanged: the latter ignores token refreshes,
    // so a role change would not reach the UI until a full sign-out and back in.
    return onIdTokenChanged(auth, async (user) => {
      if (!user) {
        provisioned.current.clear();
        setState({ status: 'signedOut' });
        return;
      }

      try {
        const { claims } = await user.getIdTokenResult();
        const session = sessionFrom(user, claims as Record<string, unknown>);

        if (session.role === null && !provisioned.current.has(user.uid)) {
          // Brand-new account: Firebase Auth created it client-side, so nothing has
          // assigned a role yet. Fill the gap, then force a refresh so the new claims
          // arrive (which re-enters this listener with role set).
          provisioned.current.add(user.uid);
          setState({ status: 'provisioning' });
          await registerClientFn();
          await user.getIdToken(true);
          return;
        }

        setState({ status: 'ready', session });
      } catch (err: unknown) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName.trim()) {
      await updateProfile(cred.user, { displayName: displayName.trim() });
    }
    // The listener above takes it from here and calls registerClient.
  }, []);

  const signOut = useCallback(async () => {
    await fbSignOut(auth);
  }, []);

  const refresh = useCallback(async () => {
    if (auth.currentUser) await auth.currentUser.getIdToken(true);
  }, []);

  return (
    <AuthContext.Provider value={{ state, signIn, signUp, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}
