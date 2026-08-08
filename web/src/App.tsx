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
              <Route
                path="/inbox"
                element={<Placeholder title="Accountant Dashboard" milestone="M3" />}
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

function Placeholder({ title, milestone }: { title: string; milestone: string }) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-ink-600">Not built yet — arrives in milestone {milestone}.</p>
    </main>
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
