#!/usr/bin/env node
/**
 * Mints the Gmail refresh token the poller runs on, and stores it in Secret Manager.
 *
 *   node scripts/gmail-auth.mjs --client-id=<ID> --client-secret=<SECRET>
 *
 * It opens a browser, waits for you to grant access to the mailbox documents arrive
 * in, exchanges the resulting code for a refresh token, and prints the three
 * `firebase functions:secrets:set` commands that put it where the functions read it.
 *
 * ── Two things that make this fail in ways the error message will not explain ──
 *
 * 1. **`prompt=consent` is not optional.** Google returns a refresh token only on the
 *    FIRST authorization of a given client/user pair. Re-run this without forcing the
 *    consent screen and the exchange succeeds, returns an access token, and contains
 *    no refresh token at all — a success that produced nothing usable.
 *
 * 2. **The OAuth consent screen must be "In production", not "Testing".** Google
 *    expires refresh tokens issued by a Testing-status app after SEVEN DAYS. The
 *    poller would work for a week and then stop, and a mailbox yielding no documents
 *    looks exactly like a quiet week. As the sole user of your own app you can publish
 *    it and click through the "Google hasn't verified this app" screen; verification
 *    is only needed to remove that warning for other people.
 *
 * Create the OAuth client as a **Desktop app** — that type accepts loopback redirects
 * without registering redirect URIs, which is the other common half-hour.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const PORT = 8910;
const REDIRECT = `http://127.0.0.1:${PORT}`;

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const clientId = arg('client-id') ?? process.env.GMAIL_CLIENT_ID;
const clientSecret = arg('client-secret') ?? process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(`
Missing credentials.

  node scripts/gmail-auth.mjs --client-id=<ID> --client-secret=<SECRET>

Get them from https://console.cloud.google.com/apis/credentials :
  Create credentials -> OAuth client ID -> Application type: Desktop app
`);
  process.exit(1);
}

/**
 * `<projectNumber>-<random>.apps.googleusercontent.com`.
 *
 * Checked here because Google's answer to a client ID it does not recognise is
 * `401: invalid_client — The OAuth client was not found`, delivered on a sign-in page
 * after the browser has opened. That message cannot distinguish a truncated paste from
 * a client created in the wrong project, and it arrives too late and too far from the
 * command to point at either. The leading digits are the project number, which is the
 * single most useful thing to see: a client created under a different Google account
 * carries a different one, and that is invisible in the console until you compare them.
 */
const CLIENT_ID_RE = /^(\d+)-[\w-]+\.apps\.googleusercontent\.com$/;
const idMatch = CLIENT_ID_RE.exec(clientId);

if (!idMatch) {
  console.error(`
That does not look like an OAuth client ID:

  ${clientId}

Expected:  <projectNumber>-<random>.apps.googleusercontent.com

The commonest cause is a partial copy — the ".apps.googleusercontent.com" suffix is
part of the ID, not decoration. Copy it from
https://console.cloud.google.com/auth/clients using the copy button rather than by
selecting the text.
`);
  process.exit(1);
}

// The placeholder from the setup instructions, pasted verbatim. Worth catching by name:
// left to Google it costs a full browser round trip and a consent grant before failing
// with "The provided client secret is invalid", which reads like a real credential
// problem rather than a copy-paste that never happened.
if (/^[<[]?YOUR[_-]?SECRET[>\]]?$/i.test(clientSecret) || /[<>]/.test(clientSecret)) {
  console.error(`
That client secret is the placeholder, not a real value:

  ${clientSecret}

Copy the actual secret from
https://console.cloud.google.com/auth/clients — open your client, and use the copy
button beside "Client secret". It begins with GOCSPX-.
`);
  process.exit(1);
}

if (!clientSecret.startsWith('GOCSPX-')) {
  // A warning, not a failure: secrets minted before ~2021 have no such prefix, and
  // refusing one outright would block a legitimate older client.
  console.warn(
    `\nWarning: client secrets normally begin with "GOCSPX-". Continuing anyway.`,
  );
}

console.log(`\nOAuth client belongs to project number ${idMatch[1]}.`);
console.log('If that is not the project holding your Firebase functions, the client was');
console.log('created under a different account or project — Google will reject it with');
console.log('"401: invalid_client (The OAuth client was not found)".');

/**
 * Opens a URL in the default browser, per platform. Best effort — the URL is printed too.
 *
 * The `^&` escaping on Windows is not cosmetic. `cmd /c` re-parses everything after it
 * as a command line, and `&` is cmd's command separator — so an unescaped consent URL
 * is TRUNCATED at the first parameter boundary. The browser then opens
 * `…/auth?client_id=…` with no response_type, no redirect_uri and no scope, and Google
 * answers with a bare "400. That's an error." that says nothing about the cause, while
 * cmd separately tries to execute `redirect_uri=…` as a program.
 *
 * The empty '' before the URL is also load-bearing: `start` reads its first quoted
 * argument as a window title, so without a placeholder it would swallow the URL.
 */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* printed below regardless */
  }
}

/** Waits for Google to redirect back with the authorization code. */
function awaitCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');

      const finish = (message) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">
          <p>${message}</p><p>You can close this tab.</p></body>`);
        server.close();
      };

      if (error) {
        finish(`Authorization failed: ${error}`);
        reject(new Error(error));
        return;
      }
      // Without the state check this loopback endpoint would accept a code from
      // anywhere for as long as it is listening.
      if (!code || state !== expectedState) {
        finish('Unexpected callback — ignoring.');
        return;
      }
      // Deliberately does NOT claim a token exists. All that has happened is that an
      // authorization CODE arrived; exchanging it for a refresh token is a separate
      // request that fails on its own — a wrong client secret being the usual way. This
      // page used to announce "FirmOffice now has a refresh token for this mailbox"
      // while the terminal printed the exchange failure, which is the worst kind of
      // wrong: two surfaces disagreeing, with the reassuring one arriving first.
      finish('Authorization received. Go back to the terminal — it reports whether the token was issued.');
      resolve(code);
    });

    server.on('error', reject);
    server.listen(PORT, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out after 5 minutes waiting for the browser.'));
    }, 300_000).unref();
  });
}

const state = randomBytes(16).toString('hex');

const consentUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    // Without offline access Google issues no refresh token at all, and the poller
    // would stop working within the hour.
    access_type: 'offline',
    // See the header note — this is what guarantees a refresh token on a re-run.
    prompt: 'consent',
    state,
  }).toString();

console.log('\nOpening the Google consent screen.');
console.log('If it does not open — OR if Google shows a bare "400. That\'s an error." —');
console.log('paste this whole URL into a browser instead:\n');
console.log(`  ${consentUrl}\n`);
console.log('Sign in as the mailbox that receives client documents.');
console.log('If you see "Google hasn\'t verified this app": Advanced -> Go to ... (unsafe).');
console.log('That warning is expected for an unverified app you built for yourself.\n');

openBrowser(consentUrl);

const code = await awaitCode(state);

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});

const token = await response.json();

if (!response.ok) {
  console.error('\nToken exchange failed:', token);
  process.exit(1);
}

if (!token.refresh_token) {
  console.error(`
Google returned an access token but NO refresh token.

That happens when this client has already been authorized for this account and the
consent screen was skipped. Revoke FirmOffice at
https://myaccount.google.com/permissions and run this again.
`);
  process.exit(1);
}

// Confirm the token actually reaches the mailbox before telling anyone it works —
// this is the difference between "configured" and "working", and the two failure
// modes downstream (wrong account, missing scope) are silent.
const probe = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
  headers: { Authorization: `Bearer ${token.access_token}` },
});
const profile = await probe.json();

if (!probe.ok) {
  console.error('\nThe token was issued but Gmail rejected it:', profile);
  process.exit(1);
}

console.log(`\nVerified: this token reads ${profile.emailAddress} (${profile.messagesTotal} messages).`);
console.log('\nStore the three secrets — each command waits for the value on stdin:\n');
console.log('  npx firebase functions:secrets:set GMAIL_CLIENT_ID');
console.log('  npx firebase functions:secrets:set GMAIL_CLIENT_SECRET');
console.log('  npx firebase functions:secrets:set GMAIL_REFRESH_TOKEN');
console.log('\nGMAIL_REFRESH_TOKEN:\n');
console.log(token.refresh_token);
console.log('\nThis value is not printed again. It is equivalent to a password for the');
console.log('mailbox, so paste it straight into the secret and do not save it to a file.\n');
