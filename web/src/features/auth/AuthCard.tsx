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
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-600">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 text-sm text-ink-600">{footer}</div>}
      </div>
    </main>
  );
}

export function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        {...props}
        className="mt-1 w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm
                   text-ink-900 outline-none focus:border-brand-500 focus:ring-2
                   focus:ring-brand-500/30 disabled:opacity-60"
      />
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white
                 hover:bg-brand-500 disabled:opacity-60"
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-900">
      {message}
    </p>
  );
}
