import { useEffect, useState, type ReactNode } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions, usingEmulators } from '@/lib/firebase';
import type { HealthCheckResponse } from '@shared';

type Probe =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; data: HealthCheckResponse }
  | { state: 'error'; message: string };

/**
 * M0 verification page.
 *
 * Proves the three things that break first on a fresh Firebase project: the web SDK
 * config is present, the SPA can reach a callable in the right region, and (in dev)
 * the emulator wiring is live. Route: /health
 */
export default function HealthPage() {
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setProbe({ state: 'running' });

    httpsCallable<void, HealthCheckResponse>(functions, 'healthCheck')()
      .then((res) => {
        if (!cancelled) setProbe({ state: 'ok', data: res.data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProbe({ state: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold tracking-tight">FirmOffice — system health</h1>
      <p className="mt-1 text-sm text-ink-600">Milestone M0 · scaffold verification</p>

      <dl className="mt-8 divide-y divide-ink-200 rounded-lg border border-ink-200">
        <Row label="Firebase project">{import.meta.env.VITE_FIREBASE_PROJECT_ID}</Row>
        <Row label="Mode">{usingEmulators ? 'Emulator suite' : 'Live project'}</Row>
        <Row label="Functions">
          {probe.state === 'running' && <span className="text-ink-400">checking…</span>}
          {probe.state === 'ok' && (
            <span className="text-emerald-600">
              reachable · v{probe.data.version} · {probe.data.serverTime}
            </span>
          )}
          {probe.state === 'error' && (
            <span className="text-red-600">unreachable — {probe.message}</span>
          )}
        </Row>
      </dl>

      {probe.state === 'error' && (
        <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          If you are running locally, start the emulators first:{' '}
          <code className="font-mono">npm run emulators</code>
        </p>
      )}
    </main>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="text-sm font-medium text-ink-600">{label}</dt>
      <dd className="font-mono text-sm">{children}</dd>
    </div>
  );
}
