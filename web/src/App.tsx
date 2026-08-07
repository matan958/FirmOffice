import { Link, Navigate, Route, Routes } from 'react-router-dom';
import HealthPage from '@/pages/HealthPage';

/**
 * Route shell.
 *
 * M1 wraps these in an AuthProvider + role guards and replaces the placeholders:
 *   /login    role-selecting email/password sign-in
 *   /portal   Client Portal — drag & drop upload            (M2)
 *   /inbox    Accountant Dashboard — list + split viewer     (M3)
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/health" replace />} />
      <Route path="/health" element={<HealthPage />} />
      <Route path="/portal" element={<Placeholder title="Client Portal" milestone="M2" />} />
      <Route path="/inbox" element={<Placeholder title="Accountant Dashboard" milestone="M3" />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function Placeholder({ title, milestone }: { title: string; milestone: string }) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-ink-600">
        Not built yet — arrives in milestone {milestone}.
      </p>
      <Link to="/health" className="mt-6 inline-block text-sm text-brand-600 underline">
        ← System health
      </Link>
    </main>
  );
}

function NotFound() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <Link to="/health" className="mt-6 inline-block text-sm text-brand-600 underline">
        ← System health
      </Link>
    </main>
  );
}
