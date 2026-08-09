import type { ReactNode } from 'react';

/** Shared chrome for the signed-out pages, so login and signup cannot drift apart. */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-ink-100 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 3.5h7.5L18.5 8.5V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinejoin="round"
              />
              <path
                d="M13 3.5V9h5.5M8.5 13h7M8.5 16.5h4.5"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="text-base font-semibold tracking-tight">FirmOffice</span>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-600">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>

        {footer && <div className="mt-5 text-center text-sm text-ink-600">{footer}</div>}
      </div>
    </main>
  );
}

export function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        {...props}
        className="mt-1.5 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm
                   text-ink-900 shadow-card outline-none transition-colors
                   placeholder:text-ink-400 focus:border-brand-500
                   focus:ring-2 focus:ring-brand-500/25 disabled:bg-ink-50 disabled:opacity-70"
      />
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600
                 px-3 py-2 text-sm font-medium text-white shadow-card transition-colors
                 hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy && <Spinner />}
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`size-3.5 animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx={12} cy={12} r={9} stroke="currentColor" strokeWidth={3} opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
    >
      <svg
        className="mt-0.5 size-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <circle cx={12} cy={12} r={9} />
        <path d="M12 7.5v5.5M12 16.2v.3" strokeLinecap="round" />
      </svg>
      <span className="min-w-0 wrap-break-word">{message}</span>
    </p>
  );
}
