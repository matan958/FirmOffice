import { useState } from 'react';
import {
  CURRENCY_SYMBOL,
  DIRECTION_CHOICES,
  DIRECTION_LABEL,
  DIRECTION_MIN_CONFIDENCE,
  EXTRACTION_FIELDS,
} from '@shared';
import type { DocDirection, DocumentDoc, ExtractedFieldSpec } from '@shared';
import { Spinner } from '@/features/auth/AuthCard';
import { DIRECTION_SOLID } from '@/features/inbox/DirectionChip';
import { correctField, setDirection } from '@/features/inbox/actions';

/**
 * The extracted fields, in the order the firm asked for them.
 *
 * Order and membership come from EXTRACTION_FIELDS — the same array that builds the
 * model's prompt — so the panel cannot show a field nobody extracts, or miss one
 * everybody pays for.
 *
 * ── Two decisions worth stating ──
 *
 * **Every field is editable.** OCR on a creased thermal receipt will get things
 * wrong, and an accountant who cannot fix a wrong total has to keep their real
 * numbers somewhere else — at which point the panel is decoration. A corrected field
 * is marked, and re-running extraction leaves it alone.
 *
 * **A blank is shown as a blank, never as zero or a dash that looks like data.**
 * "Not found" and "found, and it is nothing" are different facts on a tax document.
 */

interface Props {
  doc: DocumentDoc & { id: string };
  actorUid: string | undefined;
}

export default function ExtractedPanel({ doc, actorUid }: Props) {
  const meta = doc.extraction;
  const fields = doc.extracted ?? {};
  const corrected = new Set(meta?.correctedFields ?? []);

  if (!meta) {
    // OCR may still be running, or this is a document from before extraction existed.
    // No direction control either: there is nothing yet for a human to check it against.
    return (
      <p className="px-4 py-3 text-xs text-ink-400">
        {doc.ocr ? 'Reading the fields…' : 'Waiting for the document to be read.'}
      </p>
    );
  }

  // A failed extraction still gets the direction control. This is the case where the
  // machine read nothing at all, so it is precisely where a human needs to be able to
  // say what the document is — hiding the control behind a successful parse would take
  // the tool away at the only moment it is the only thing available.
  if (meta.error) {
    return (
      <div className="px-4 py-3">
        <DirectionBlock doc={doc} actorUid={actorUid} />
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          The fields could not be read automatically — the text below is unaffected, and
          you can still fill them in by hand.
          <span className="mt-1 block font-mono text-[11px] opacity-70">{meta.error}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <DirectionBlock doc={doc} actorUid={actorUid} />

      {meta.amountsMismatch && (
        <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>הסכומים אינם מסתדרים.</strong> סכום לפני מע״מ ועוד מע״מ אינם שווים
          לסה״כ לתשלום — כנראה ספרה שנקראה לא נכון.
        </p>
      )}

      <dl dir="rtl" className="divide-y divide-ink-200 text-sm">
        {EXTRACTION_FIELDS.map((spec) => (
          <Row
            key={spec.key}
            spec={spec}
            value={fields[spec.key] ?? null}
            currency={fields.currency ?? 'ILS'}
            corrected={corrected.has(spec.key)}
            docId={doc.id}
            actorUid={actorUid}
          />
        ))}
      </dl>
    </div>
  );
}

/**
 * Income or expense — above the eight fields, because it is the answer rather than a
 * ninth thing read off the page.
 *
 * It shows its reasoning on purpose. This one value decides whether a document's VAT is
 * reported as מע"מ עסקאות or as מע"מ תשומות, so an accountant has to be able to check
 * it against the scan beside them in a second, not take it on trust. The two parties
 * are printed underneath for exactly that: they are the evidence, which is also why
 * they get no row of their own in the list below.
 */
function DirectionBlock({
  doc,
  actorUid,
}: {
  doc: DocumentDoc & { id: string };
  actorUid: string | undefined;
}) {
  const [busy, setBusy] = useState<DocDirection | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `classification` is genuinely absent on older documents and on anything still being
  // read — hence the optional type. Do not "simplify" this to a !== null check.
  const current = doc.classification;
  const fields = doc.extracted ?? {};
  const needsCheck =
    !current || current.direction === 'unknown' || current.confidence < DIRECTION_MIN_CONFIDENCE;

  async function choose(direction: DocDirection) {
    if (!actorUid) return;
    setBusy(direction);
    setError(null);
    try {
      await setDirection(doc.id, direction, actorUid);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div dir="rtl" className="mb-3 rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2.5">
      <div className="flex items-center gap-1">
        {DIRECTION_CHOICES.map((choice) => {
          const active = current?.direction === choice;
          return (
            <button
              key={choice}
              onClick={() => void choose(choice)}
              disabled={!actorUid || busy !== null}
              className={[
                'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                'disabled:cursor-not-allowed',
                // The chosen button wears the direction's own colour, not the brand
                // accent — otherwise picking הכנסה here shows blue, and the same
                // document then shows green in the list, which reads as two decisions.
                active
                  ? `${DIRECTION_SOLID[choice]} shadow-sm`
                  : 'bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-100 disabled:hover:bg-white',
              ].join(' ')}
            >
              {busy === choice ? <Spinner /> : DIRECTION_LABEL[choice]}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
        {current ? current.reason : 'טרם סווג'}
        {current?.source === 'manual' && (
          <span className="mr-1.5 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
            ידני
          </span>
        )}
      </p>

      {(fields.vendorName || fields.recipientName) && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
          {fields.vendorName && (
            <>
              מנפיק: {fields.vendorName}
              {fields.vendorTaxId && <span dir="ltr"> · {fields.vendorTaxId}</span>}
            </>
          )}
          {fields.vendorName && fields.recipientName && <br />}
          {fields.recipientName && (
            <>
              לקוח: {fields.recipientName}
              {fields.recipientTaxId && <span dir="ltr"> · {fields.recipientTaxId}</span>}
            </>
          )}
        </p>
      )}

      {needsCheck && current?.source !== 'manual' && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          צריך בדיקה — בחר/י את הסיווג הנכון.
        </p>
      )}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Row({
  spec,
  value,
  currency,
  corrected,
  docId,
  actorUid,
}: {
  spec: ExtractedFieldSpec;
  value: string | number | null;
  currency: string;
  corrected: boolean;
  docId: string;
  actorUid: string | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await correctField(docId, spec, draft);
      setEditing(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="shrink-0 text-xs font-medium text-ink-500">{spec.label}</dt>

      <dd className="min-w-0 flex-1 text-left">
        {editing ? (
          <span className="flex items-center justify-start gap-1.5" dir="ltr">
            <input
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full rounded-md border border-brand-400 px-2 py-1 text-sm outline-none
                         focus:ring-2 focus:ring-brand-500/25"
            />
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded-md bg-brand-600 px-2 py-1 text-xs text-white disabled:opacity-50"
            >
              {busy ? <Spinner /> : 'Save'}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-md px-1.5 py-1 text-xs text-ink-500 hover:bg-ink-100"
            >
              ✕
            </button>
          </span>
        ) : (
          <button
            onClick={() => {
              setDraft(value === null ? '' : String(value));
              setEditing(true);
            }}
            disabled={!actorUid}
            dir="ltr"
            title="Click to correct"
            className={[
              'w-full rounded-md px-2 py-1 text-left transition-colors',
              'hover:bg-ink-100 disabled:hover:bg-transparent',
              value === null ? 'text-ink-300' : 'text-ink-900',
            ].join(' ')}
          >
            {format(spec, value, currency)}
            {corrected && (
              <span
                className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700"
                title="Corrected by hand — automatic re-reads will not overwrite it"
              >
                edited
              </span>
            )}
          </button>
        )}

        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </dd>
    </div>
  );
}

/** Display only. The stored value stays canonical: ISO dates, plain numbers. */
function format(spec: ExtractedFieldSpec, value: string | number | null, currency: string): string {
  // An em dash in the muted colour, so a blank reads as "nothing here" rather than as
  // a value. Deliberately not "0" or "—" in normal weight, either of which an
  // accountant could copy into a ledger.
  if (value === null || value === '') return '—';

  if (spec.kind === 'money' && typeof value === 'number') {
    const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
    return `${symbol}${value.toLocaleString('he-IL', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  if (spec.kind === 'date' && typeof value === 'string') {
    // Stored ISO, shown day-first, because that is how the document itself reads.
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
  }

  return String(value);
}
