// Sends each product's vertical video to the Lybloo TikTok inbox as a draft. Unaudited TikTok apps
// can't publish publicly, so a person opens TikTok, pastes the caption from docs/tiktok.html and
// taps Post.
//
// TikTok access tokens last 24 hours and each refresh may hand back a new refresh token. The
// workflow can't rewrite GitHub secrets, so the refresh token lives in tiktok-state.enc, encrypted
// with a key derived from TIKTOK_CLIENT_SECRET, and the workflow commits it after every run.
//
// One-time connect: open docs/tiktok-connect.html, approve, then run the workflow with the code
// it shows in the "tiktok_code" box.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const API = 'https://open.tiktokapis.com/v2';
const STATE_FILE = new URL('./tiktok-state.enc', import.meta.url);
const CAPTIONS_PAGE = new URL('./docs/tiktok.html', import.meta.url);
export const REDIRECT_URI = 'https://nauman-aziz.github.io/lybloo-social-autopost/tiktok-connect.html';
const MAX_CAPTIONS = 20;

// Trimmed because a secret pasted from the developer portal easily picks up a trailing space or newline.
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY?.trim();
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET?.trim();
export const tiktokConfigured = () => Boolean(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET);

const key = () => createHash('sha256').update(`lybloo-tiktok:${TIKTOK_CLIENT_SECRET}`).digest();

async function loadState() {
  const raw = await readFile(STATE_FILE, 'utf8').catch(() => null);
  if (!raw) return null;
  const [iv, tag, data] = raw.trim().split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

async function saveState(state) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  await writeFile(STATE_FILE, [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.') + '\n');
}

async function tokenRequest(params) {
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET, ...params }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`TikTok token: ${body.error_description || body.error || res.status}`);
  return body;
}

async function storeTokens(body) {
  await saveState({
    refresh_token: body.refresh_token,
    refresh_expires_at: new Date(Date.now() + body.refresh_expires_in * 1000).toISOString(),
    open_id: body.open_id,
    scope: body.scope,
  });
  return body.access_token;
}

// Exchanges the one-time code from the connect page for tokens.
export async function connect(code) {
  const body = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI });
  await storeTokens(body);
  console.log(`TikTok connected (scopes: ${body.scope}), login valid until ${new Date(Date.now() + body.refresh_expires_in * 1000).toISOString().slice(0, 10)}`);
}

async function accessToken() {
  const state = await loadState();
  if (!state) throw new Error('TikTok is not connected yet (no tiktok-state.enc); see README');
  return storeTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: state.refresh_token }));
}

async function api(token, path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error?.code && json.error.code !== 'ok') throw new Error(`TikTok ${path}: ${json.error.code} ${json.error.message}`);
  return json.data;
}

// Uploads the video in one chunk (TikTok allows a single chunk up to 64 MB) and waits until
// TikTok has delivered it to the inbox.
export async function sendDraft(video) {
  const token = await accessToken();
  const { publish_id, upload_url } = await api(token, '/post/publish/inbox/video/init/', {
    source_info: { source: 'FILE_UPLOAD', video_size: video.length, chunk_size: video.length, total_chunk_count: 1 },
  });

  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(video.length),
      'Content-Range': `bytes 0-${video.length - 1}/${video.length}`,
    },
    body: video,
  });
  if (!put.ok) throw new Error(`TikTok upload: HTTP ${put.status} ${await put.text()}`);

  for (let attempt = 0; attempt < 24; attempt++) {
    const { status, fail_reason } = await api(token, '/post/publish/status/fetch/', { publish_id });
    if (status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE') return publish_id;
    if (status === 'FAILED') throw new Error(`TikTok draft failed: ${fail_reason}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`TikTok draft ${publish_id} still processing after 2 minutes`);
}

const escape = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Inbox drafts can't carry a caption, so this page lists each one with a copy button.
export async function renderCaptionsPage(posted) {
  const items = Object.values(posted)
    .filter((item) => item.tiktok_caption)
    .sort((a, b) => (b.last_posted_at ?? '').localeCompare(a.last_posted_at ?? ''))
    .slice(0, MAX_CAPTIONS);

  const cards = items
    .map(
      (item, i) => `
    <article>
      <h2>${escape(item.product_title)}</h2>
      <p class="when">Sent ${escape(new Date(item.last_posted_at).toLocaleString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }))}${item.tiktok_status === 'sent' ? '' : ' · draft not sent'}</p>
      <textarea id="c${i}" readonly rows="7">${escape(item.tiktok_caption)}</textarea>
      <button onclick="navigator.clipboard.writeText(document.getElementById('c${i}').value).then(() => { this.textContent = 'Copied ✓'; })">Copy caption</button>
    </article>`,
    )
    .join('');

  await mkdir(new URL('./', CAPTIONS_PAGE), { recursive: true });
  await writeFile(
    CAPTIONS_PAGE,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>TikTok Captions · Lybloo</title>
  <style>
    :root { --bg: #f5f5f7; --card: #fff; --text: #1d1d1f; --muted: #6e6e73; --accent: #0066cc; }
    @media (prefers-color-scheme: dark) { :root { --bg: #000; --card: #1c1c1e; --text: #f5f5f7; --muted: #a1a1a6; --accent: #2997ff; } }
    * { box-sizing: border-box; margin: 0; }
    body { background: var(--bg); color: var(--text); font-family: Inter, -apple-system, system-ui, sans-serif; }
    main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { font-size: 24px; } .lead { color: var(--muted); margin: 6px 0 20px; font-size: 15px; }
    article { background: var(--card); border-radius: 16px; padding: 16px; margin-bottom: 12px; }
    h2 { font-size: 16px; } .when { color: var(--muted); font-size: 13px; margin: 4px 0 10px; }
    textarea { width: 100%; font: inherit; font-size: 14px; padding: 10px; border-radius: 10px; border: 1px solid #d2d2d7; background: transparent; color: inherit; resize: none; }
    button { margin-top: 10px; width: 100%; padding: 12px; border: 0; border-radius: 980px; background: var(--accent); color: #fff; font-weight: 600; font-size: 15px; }
  </style>
</head>
<body>
  <main>
    <h1>TikTok captions</h1>
    <p class="lead">Open the draft in TikTok, copy its caption here, paste it, and tap Post. Newest first.</p>
    ${cards || '<p class="lead">No drafts sent yet.</p>'}
  </main>
</body>
</html>
`,
  );
}

// `node tiktok.mjs connect <code>` is what the workflow runs when a code is pasted into it.
if (process.argv[2] === 'connect') {
  connect(process.argv[3]).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
