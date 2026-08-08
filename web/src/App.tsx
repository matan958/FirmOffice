import { Suspense, lazy } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import HealthPage from '@/pages/HealthPage';
import Shell from '@/components/Shell';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { RequireAuth, RequireRole, RoleLanding } from '@/features/auth/guards';
import LoginPage from '@/features/auth/LoginPage';
import SignupPage from '@/features/auth/SignupPage';
import PendingPage from '@/features/auth/PendingPage';
import ClientsPage from '@/features/clients/ClientsPage';
import UsersPage from '@/features/admin/UsersPage';
import PortalPage from '@/features/portal/PortalPage';
import InboxPage from '@/features/inbox/InboxPage';
/**
 * Lazy: this route pulls in react-pdf and the ~1 MB pdf.js worker. Bundled eagerly it
 * doubled the entry chunk for every page, including the login screen — so a client
 * uploading a photo paid to download a PDF renderer they will never open. Only
 * accountants reach the viewer, and only on demand.
 */
const DocumentViewerPage = lazy(() => import('@/features/viewer/DocumentViewerPage'));

const ACCOUNTANT = ['accountant', 'admin'] as const;
const ADMIN = ['admin'] as const;
const CLIENT = ['client'] as const;

/**
 * Route shell.
 *
 * Guards here are convenience only — the real boundary is firestore.rules /
 * storage.rules, which verify the same claims server-side. See features/auth/guards.
 */
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />

        {/* Signed in */}
        <Route element={<RequireAuth />}>
          <Route path="/" element={<RoleLanding />} />
          {/* Outside the shell: a pending client has no navigation to offer. */}
          <Route path="/pending" element={<PendingPage />} />

          <Route element={<Shell />}>
            <Route path="/health" element={<HealthPage />} />

            <Route element={<RequireRole allow={CLIENT} />}>
              <Route path="/portal" element={<PortalPage />} />
            </Route>

            <Route element={<RequireRole allow={ACCOUNTANT} />}>
              <Route path="/inbox" element={<InboxPage />} />
              <Route
                path="/inbox/:docId"
                element={
                  <Suspense fallback={<p className="p-8 text-sm text-ink-600">Loading viewer…</p>}>
                    <DocumentViewerPage />
                  </Suspense>
                }
              />
              <Route path="/clients" element={<ClientsPage />} />
            </Route>

            <Route element={<RequireRole allow={ADMIN} />}>
              <Route path="/users" element={<UsersPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}

function NotFound() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <Link to="/" className="mt-6 inline-block text-sm text-brand-600 underline">
        ← Home
      </Link>
    </main>
  );
}
