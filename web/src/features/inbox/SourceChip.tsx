import type { DocumentDoc, GmailSource } from '@shared';

/**
 * Where a document came from, and how much to trust the client it was filed under.
 *
 * The verify affordance appears only on matches that warrant it. A domain match, or a
 * message whose sender could not be authenticated, is a guess the firm should spot-
 * check; an alias or an exact address match is not, and putting a warning on those
 * teaches accountants to ignore all of them.
 */

/** Above this the match is treated as settled — alias, exact address, manual filing. */
const TRUSTED_CONFIDENCE = 0.9;

export default function SourceChip({ doc }: { doc: DocumentDoc }) {
  const match = doc.clientMatch;
  const from = doc.channel === 'gmail' ? (doc.source as GmailSource).from : null;

  const label = doc.channel === 'gmail' ? 'Mail' : doc.channel === 'web' ? 'Portal' : 'WhatsApp';

  const uncertain =
    doc.clientId !== null &&
    match !== null &&
    (match.confidence < TRUSTED_CONFIDENCE || match.authDowngraded === true);

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-600"
        title={from ?? undefined}
      >
        {label}
      </span>

      {uncertain && (
        <span
          className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900"
          title={
            match?.authDowngraded
              ? 'The receiving server could not confirm this sender. Filed on a weakened match — worth checking.'
              : `Matched by ${match?.method} at ${Math.round((match?.confidence ?? 0) * 100)}% confidence.`
          }
        >
          verify?
        </span>
      )}
    </span>
  );
}
