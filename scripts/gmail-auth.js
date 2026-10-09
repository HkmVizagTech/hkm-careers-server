/**
 * One-time helper: get a Gmail refresh token for the account that sends careers emails.
 *
 *   1. Google Cloud console -> APIs & Services: enable "Gmail API".
 *   2. OAuth consent screen: Internal (Workspace) or External + add yourself as a test user.
 *   3. Credentials -> Create OAuth client ID -> type "Desktop app". Copy the ID and secret.
 *   4. Run on your computer (not on Railway):
 *        GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-auth.js
 *      (PowerShell: $env:GMAIL_CLIENT_ID="..."; $env:GMAIL_CLIENT_SECRET="..."; node scripts/gmail-auth.js)
 *   5. Sign in as the sending address (e.g. careers@harekrishnavizag.org) and allow "Send email".
 *   6. Put the printed GMAIL_REFRESH_TOKEN, plus the ID and secret, into Railway.
 *
 * Only the "send email" permission is requested; the site cannot read the mailbox.
 */
const http = require('http');
const { randomBytes } = require('crypto');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const PORT = Number(process.env.PORT_AUTH) || 5577;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first (see the comment at the top of this file).');
  process.exit(1);
}

const state = randomBytes(12).toString('hex');
const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    state,
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  if (url.searchParams.get('state') !== state) return res.writeHead(400).end('State mismatch, please retry.');
  const code = url.searchParams.get('code');
  if (!code) return res.writeHead(400).end(`Sign-in cancelled: ${url.searchParams.get('error') || 'no code'}`);

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) throw new Error(data.error_description || data.error || 'No refresh token returned');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>Done. You can close this tab and go back to the terminal.</h2>');
    console.log('\nAdd these to Railway (server service variables):\n');
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${data.refresh_token}\n`);
  } catch (err) {
    res.writeHead(500).end(`Failed: ${err.message}`);
    console.error('Failed:', err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this link, sign in as the sending Gmail/Workspace account and allow access:\n');
  console.log(authUrl + '\n');
});
