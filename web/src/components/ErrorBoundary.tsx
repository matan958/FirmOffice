import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render crash and shows something, instead of nothing.
 *
 * React unmounts the entire tree when a render throws and no boundary catches it. The
 * result is a blank white page with no message, no navigation and no way back — and
 * the cause is only visible in the browser console, which is not somewhere an
 * accountant is going to look. One bad field on one document took out the whole app
 * exactly this way.
 *
 * This does not make the bug go away; it makes it reportable. The user gets the error
 * text and a way out, rather than having to guess whether the system is down.
 *
 * A class component because there is still no hook equivalent — `componentDidCatch`
 * has no functional counterpart.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[firmoffice] render crash', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="grid min-h-dvh place-items-center bg-ink-100 p-6">
        <div className="card w-full max-w-lg p-6">
          <h1 className="text-lg font-semibold tracking-tight">Something broke on this screen</h1>
          <p className="mt-1.5 text-sm text-ink-600">
            Your documents are safe — this is a display fault, not data loss. Reloading
            usually clears it.
          </p>

          <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-ink-100 p-3 font-mono text-xs text-ink-700">
            {error.message}
          </pre>

          <div className="mt-5 flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white
                         shadow-card transition-colors hover:bg-brand-500"
            >
              Reload
            </button>
            <button
              // Full navigation, not a router push: the router lives inside the tree
              // this boundary has just torn down.
              onClick={() => (window.location.href = '/')}
              className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm
                         transition-colors hover:bg-ink-50"
            >
              Go to start
            </button>
          </div>
        </div>
      </main>
    );
  }
}
