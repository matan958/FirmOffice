import { describe, expect, it } from 'vitest';
import {
  aliasTagsFor,
  domainOf,
  forwardedSender,
  header,
  parseAddress,
  parseAddressList,
  parseAuthResults,
  plusTagOf,
  subjectCode,
} from '../src/mapping/headers.js';
import { resolveClient, type IdentifierLookup } from '../src/mapping/resolveClient.js';
import { SUBJECT_CODE_RE, identifierKey } from '../src/shared.js';
import type { ClientIdentifierDoc } from '../src/shared.js';

/**
 * The mapping matrix. Every rung, plus the four cases that quietly file documents
 * under the wrong client if they are wrong: a public-domain sender, a spoofed
 * `From:`, a forward, and a strong rung being pre-empted by a weak one.
 */

const MAILBOX = 'firmoffice.docs@gmail.com';

/** A stored identifier, with the confidence the seeding code would have given it. */
function identifier(
  over: Partial<ClientIdentifierDoc> & Pick<ClientIdentifierDoc, 'type' | 'value' | 'clientId' | 'confidence'>,
): ClientIdentifierDoc {
  return {
    verified: true,
    source: 'seed',
    createdBy: null,
    createdAt: { seconds: 0, nanoseconds: 0, toDate: () => new Date(0), toMillis: () => 0 },
    lastMatchedAt: null,
    matchCount: 0,
    ...over,
  };
}

/** Builds a lookup over a fixed table, and records what was asked for. */
function lookupOver(table: Record<string, ClientIdentifierDoc>): IdentifierLookup & { asked: string[] } {
  const asked: string[] = [];
  const fn = async (key: string) => {
    asked.push(key);
    return table[key] ?? null;
  };
  return Object.assign(fn, { asked });
}

const PASS = { dkimPass: true, spfPass: true, dmarcPass: true };
const FAIL = { dkimPass: false, spfPass: false, dmarcPass: false };
const UNKNOWN = { dkimPass: null, spfPass: null, dmarcPass: null };

function message(over: Partial<Parameters<typeof resolveClient>[0]> = {}) {
  return {
    from: 'billing@acme.com',
    recipients: [MAILBOX],
    replyTo: null,
    subject: 'Invoice 4471',
    bodyText: null,
    auth: PASS,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Header parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAddressList', () => {
  it('reads angle-bracket and bare forms', () => {
    expect(parseAddress('Acme Billing <billing@acme.com>')).toBe('billing@acme.com');
    expect(parseAddress('billing@acme.com')).toBe('billing@acme.com');
  });

  it('does not split on a comma inside a quoted display name', () => {
    // The naive `value.split(',')` produces two garbage addresses here, and the
    // second one poisons the alias rung with a nonsense recipient.
    expect(parseAddressList('"Doe, John" <john@acme.com>, jane@acme.com')).toEqual([
      'john@acme.com',
      'jane@acme.com',
    ]);
  });

  it('lowercases, because identifier keys are case-folded', () => {
    expect(parseAddress('<Billing@ACME.com>')).toBe('billing@acme.com');
  });

  it('survives junk rather than throwing', () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
  });
});

describe('header', () => {
  it('matches case-insensitively', () => {
    const headers = [{ name: 'From', value: 'a@b.com' }];
    expect(header(headers, 'from')).toBe('a@b.com');
    expect(header(headers, 'FROM')).toBe('a@b.com');
    expect(header(headers, 'to')).toBeNull();
  });
});

describe('plusTagOf / aliasTagsFor', () => {
  it('extracts the tag', () => {
    expect(plusTagOf('docs+acme7k2@firm.com')).toBe('acme7k2');
    expect(plusTagOf('docs@firm.com')).toBeNull();
    expect(plusTagOf('docs+@firm.com')).toBeNull();
  });

  it('matches the mailbox through Gmail dot-insensitivity', () => {
    // A client typing the address by hand adds a dot; Gmail delivers it anyway. If
    // this did not normalize, that client would sit in Unassigned permanently.
    expect(aliasTagsFor(['firm.office.docs+acme7k2@gmail.com'], MAILBOX)).toEqual(['acme7k2']);
  });

  it('ignores plus-addresses aimed at a different mailbox', () => {
    expect(aliasTagsFor(['someoneelse+acme7k2@gmail.com'], MAILBOX)).toEqual([]);
  });
});

describe('parseAuthResults', () => {
  it('prefers the receiving provider’s own header over an upstream one', () => {
    // An attacker controls every hop before Gmail and can prepend a forged pass.
    const results = parseAuthResults([
      'evil-relay.example; dkim=pass header.i=@acme.com; spf=pass',
      'mx.google.com; dkim=fail header.i=@acme.com; spf=softfail',
    ]);
    expect(results.dkimPass).toBe(false);
    expect(results.spfPass).toBe(false);
  });

  it('reads a normal Gmail verdict', () => {
    const results = parseAuthResults([
      'mx.google.com; dkim=pass header.i=@acme.com; spf=pass smtp.mailfrom=billing@acme.com; dmarc=pass',
    ]);
    expect(results).toEqual({ dkimPass: true, spfPass: true, dmarcPass: true });
  });

  it('reports an absent header as unknown, not as failure', () => {
    // "Unproven" and "forged" must not collapse into the same value — treating the
    // first as the second would route legitimate mail to Unassigned forever.
    expect(parseAuthResults([])).toEqual({ dkimPass: null, spfPass: null, dmarcPass: null });
  });

  it('treats dkim=none as not-passing', () => {
    expect(parseAuthResults(['mx.google.com; dkim=none; spf=pass']).dkimPass).toBe(false);
  });
});

describe('forwardedSender', () => {
  const body = [
    'FYI — please file this one.',
    '',
    '---------- Forwarded message ---------',
    'From: Acme Billing <billing@acme.com>',
    'Date: Tue, 5 Aug 2026 at 10:12',
    'Subject: Invoice 4471',
    'To: Ronit <ronit@firm.com>',
  ].join('\n');

  it('parses the quoted original sender', () => {
    expect(forwardedSender('Fwd: Invoice 4471', body)).toBe('billing@acme.com');
  });

  it('works from the body marker alone, with no Fwd: subject', () => {
    expect(forwardedSender('Invoice 4471', body)).toBe('billing@acme.com');
  });

  it('ignores "from:" appearing in ordinary prose', () => {
    // Unanchored matching files the document under whatever address the prose names.
    const prose = 'Fwd: see below\n\nI got the invoice from: someone at accounts@wrong.com';
    expect(forwardedSender('Fwd: see below', prose)).toBeNull();
  });

  it('returns null when nothing suggests a forward', () => {
    expect(forwardedSender('Invoice 4471', 'From: billing@acme.com')).toBeNull();
    expect(forwardedSender('Fwd: hello', null)).toBeNull();
  });
});

describe('subjectCode / domainOf', () => {
  it('captures a bracketed code', () => {
    expect(subjectCode('Invoice [ACME-123] attached', SUBJECT_CODE_RE)).toBe('acme-123');
    expect(subjectCode('Invoice attached', SUBJECT_CODE_RE)).toBeNull();
  });

  it('extracts a domain', () => {
    expect(domainOf('billing@Acme.COM')).toBe('acme.com');
    expect(domainOf('not-an-address')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ladder
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveClient', () => {
  it('rung 1 — a plus-address alias files at full confidence', async () => {
    const lookup = lookupOver({
      [identifierKey('alias', 'acme7k2')]: identifier({
        type: 'alias', value: 'acme7k2', clientId: 'client-acme', confidence: 1,
      }),
    });

    const result = await resolveClient(
      message({ from: 'anyone@anywhere.example', recipients: [`firmoffice.docs+acme7k2@gmail.com`] }),
      lookup,
      { ingestMailbox: MAILBOX },
    );

    expect(result.clientId).toBe('client-acme');
    expect(result.method).toBe('alias');
    expect(result.confidence).toBe(1);
    expect(result.aliasTag).toBe('acme7k2');
  });

  it('rung 1 survives a failing DKIM, because the alias is not a sender claim', async () => {
    // The evidence is the address the message was DELIVERED to. A forged `From:`
    // says nothing about it, so downgrading here would only punish real clients.
    const lookup = lookupOver({
      [identifierKey('alias', 'acme7k2')]: identifier({
        type: 'alias', value: 'acme7k2', clientId: 'client-acme', confidence: 1,
      }),
    });

    const result = await resolveClient(
      message({ recipients: ['firmoffice.docs+acme7k2@gmail.com'], auth: FAIL }),
      lookup,
      { ingestMailbox: MAILBOX },
    );

    expect(result.clientId).toBe('client-acme');
    expect(result.authDowngraded).toBe(false);
  });

  it('rung 2 — an exact sender address files', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'billing@acme.com')]: identifier({
        type: 'email', value: 'billing@acme.com', clientId: 'client-acme', confidence: 0.95,
      }),
    });

    const result = await resolveClient(message(), lookup, { ingestMailbox: MAILBOX });
    expect(result).toMatchObject({ clientId: 'client-acme', method: 'email', confidence: 0.95 });
  });

  it('normalizes a +tag and dots on the SENDER address too', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'jsmith@gmail.com')]: identifier({
        type: 'email', value: 'jsmith@gmail.com', clientId: 'client-smith', confidence: 0.95,
      }),
    });

    const result = await resolveClient(
      message({ from: 'j.smith+receipts@gmail.com' }),
      lookup,
      { ingestMailbox: MAILBOX },
    );
    expect(result.clientId).toBe('client-smith');
  });

  it('a spoofed sender is downgraded to a suggestion, not filed', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'billing@acme.com')]: identifier({
        type: 'email', value: 'billing@acme.com', clientId: 'client-acme', confidence: 0.95,
      }),
    });

    const result = await resolveClient(message({ auth: FAIL }), lookup, { ingestMailbox: MAILBOX });

    expect(result.clientId).toBeNull();
    expect(result.suggestedClientId).toBe('client-acme');
    expect(result.authDowngraded).toBe(true);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('an unsigned but SPF-valid sender still files', async () => {
    // dkim=none is the common case for small senders. Requiring DKIM would exile
    // them to Unassigned permanently and train accountants to stop reading it.
    const lookup = lookupOver({
      [identifierKey('email', 'billing@acme.com')]: identifier({
        type: 'email', value: 'billing@acme.com', clientId: 'client-acme', confidence: 0.95,
      }),
    });

    const result = await resolveClient(
      message({ auth: { dkimPass: false, spfPass: true, dmarcPass: null } }),
      lookup,
      { ingestMailbox: MAILBOX },
    );
    expect(result.clientId).toBe('client-acme');
    expect(result.authDowngraded).toBe(false);
  });

  it('an absent Authentication-Results header does not downgrade', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'billing@acme.com')]: identifier({
        type: 'email', value: 'billing@acme.com', clientId: 'client-acme', confidence: 0.95,
      }),
    });
    const result = await resolveClient(message({ auth: UNKNOWN }), lookup, { ingestMailbox: MAILBOX });
    expect(result.clientId).toBe('client-acme');
  });

  it('rung 5 — a corporate domain files at 0.60', async () => {
    const lookup = lookupOver({
      [identifierKey('domain', 'acme.com')]: identifier({
        type: 'domain', value: 'acme.com', clientId: 'client-acme', confidence: 0.6,
      }),
    });

    const result = await resolveClient(
      message({ from: 'someone.new@acme.com' }),
      lookup,
      { ingestMailbox: MAILBOX },
    );
    expect(result).toMatchObject({ clientId: 'client-acme', method: 'domain' });
  });

  it('NEVER domain-matches a public mailbox provider', async () => {
    // The single most damaging row this table can contain: one `domain:gmail.com`
    // entry maps every Gmail user on earth to one client. The lookup must not even
    // be attempted, so the blocklist cannot be defeated by a row someone created.
    const lookup = lookupOver({
      [identifierKey('domain', 'gmail.com')]: identifier({
        type: 'domain', value: 'gmail.com', clientId: 'client-oops', confidence: 0.6,
      }),
    });

    const result = await resolveClient(
      message({ from: 'a.stranger@gmail.com' }),
      lookup,
      { ingestMailbox: MAILBOX },
    );

    expect(result.clientId).toBeNull();
    expect(result.method).toBe('none');
    expect(lookup.asked).not.toContain(identifierKey('domain', 'gmail.com'));
  });

  it('a subject code beats a domain match on the same message', async () => {
    // The plan's table orders domain (0.60) above subject code (0.85). With
    // first-hit-wins that ordering files this message under the wrong client.
    const lookup = lookupOver({
      [identifierKey('subjectCode', 'globex-9')]: identifier({
        type: 'subjectCode', value: 'globex-9', clientId: 'client-globex', confidence: 0.85,
      }),
      [identifierKey('domain', 'acme.com')]: identifier({
        type: 'domain', value: 'acme.com', clientId: 'client-acme', confidence: 0.6,
      }),
    });

    const result = await resolveClient(
      message({ from: 'ap@acme.com', subject: 'Docs for [GLOBEX-9]' }),
      lookup,
      { ingestMailbox: MAILBOX },
    );

    expect(result.clientId).toBe('client-globex');
    expect(result.method).toBe('subjectCode');
  });

  it('rung 4 — a forward files under the ORIGINAL sender, not the forwarder', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'billing@acme.com')]: identifier({
        type: 'email', value: 'billing@acme.com', clientId: 'client-acme', confidence: 0.95,
      }),
      [identifierKey('email', 'ronit@firm.com')]: identifier({
        type: 'email', value: 'ronit@firm.com', clientId: 'client-firm-staff', confidence: 0.95,
      }),
    });

    const result = await resolveClient(
      message({
        from: 'billing@acme.com',
        subject: 'Fwd: Invoice 4471',
        bodyText: '---------- Forwarded message ---------\nFrom: Acme <billing@acme.com>',
      }),
      lookup,
      { ingestMailbox: MAILBOX },
    );

    // The exact-sender rung is stronger and runs first here; what matters is the
    // forwarded path below, where the forwarder is NOT a known identifier.
    expect(result.clientId).toBe('client-acme');
  });

  it('a forward from an unknown forwarder resolves to the quoted sender at 0.70', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'billing@acme.com')]: identifier({
        type: 'email', value: 'billing@acme.com', clientId: 'client-acme', confidence: 0.95,
      }),
    });

    const result = await resolveClient(
      message({
        from: 'ronit@firm.com',
        subject: 'Fwd: Invoice 4471',
        bodyText: '---------- Forwarded message ---------\nFrom: Acme <billing@acme.com>',
      }),
      lookup,
      { ingestMailbox: MAILBOX },
    );

    expect(result.method).toBe('forwarded');
    expect(result.clientId).toBe('client-acme');
    // The identifier's own 0.95 must not leak into a 0.70 rung.
    expect(result.confidence).toBe(0.7);
  });

  it('rung 6 — reply-to can only ever suggest, never file', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'ap@globex.com')]: identifier({
        type: 'email', value: 'ap@globex.com', clientId: 'client-globex', confidence: 0.95,
      }),
    });

    const result = await resolveClient(
      message({ from: 'noreply@portal.example', replyTo: 'ap@globex.com' }),
      lookup,
      { ingestMailbox: MAILBOX },
    );

    expect(result.method).toBe('replyTo');
    expect(result.clientId).toBeNull();
    expect(result.suggestedClientId).toBe('client-globex');
  });

  it('an identifier may lower its own confidence but not raise it', async () => {
    const lookup = lookupOver({
      [identifierKey('email', 'billing@acme.com')]: identifier({
        type: 'email', value: 'billing@acme.com', clientId: 'client-acme', confidence: 0.4,
      }),
    });

    const result = await resolveClient(message(), lookup, { ingestMailbox: MAILBOX });
    expect(result.confidence).toBe(0.4);
    expect(result.clientId).toBeNull();
    expect(result.suggestedClientId).toBe('client-acme');
  });

  it('nothing matches → Unassigned with no suggestion', async () => {
    const result = await resolveClient(
      message({ from: 'stranger@nowhere.example' }),
      lookupOver({}),
      { ingestMailbox: MAILBOX },
    );

    expect(result).toMatchObject({
      clientId: null,
      method: 'none',
      confidence: 0,
      suggestedClientId: null,
      matchedIdentifier: null,
    });
  });
});
