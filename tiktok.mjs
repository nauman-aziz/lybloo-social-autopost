// Prepares a TikTok photo post for each product (story card, product photos, price card) with its
// title and description filled in, and sends it to the Lybloo TikTok inbox. Unaudited TikTok apps
// can't publish publicly, so a person opens the notification and taps Post.
//
// TikTok only pulls photos from a verified URL prefix, so the post runs in two halves: post.mjs
// writes the photos under docs/tiktok/ plus tiktok-pending.json, the workflow publishes them to
// GitHub Pages, and `node tiktok.mjs send-pending` waits for them to be live and sends the post.
//
// TikTok access tokens last 24 hours and each refresh may hand back a new refresh token. The
// workflow can't rewrite GitHub secrets, so the refresh token lives in tiktok-state.enc, encrypted
// with a key derived from TIKTOK_CLIENT_SECRET, and the workflow commits it after every run.
//
// One-time connect: open docs/tiktok-connect.html, approve, then run the workflow with the code
// it shows in the "tiktok_code" box.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hashtags } from './hashtags.mjs';
import { ctaSlide, photoSlide } from './reel.mjs';
import { buildStoryImage } from './story.mjs';

const API = 'https://open.tiktokapis.com/v2';
const STATE_FILE = new URL('./tiktok-state.enc', import.meta.url);
const PENDING_FILE = new URL('./tiktok-pending.json', import.meta.url);
const POSTED_FILE = new URL('./posted.json', import.meta.url);
const PHOTOS_DIR = new URL('./docs/tiktok/', import.meta.url);
const PHOTOS_URL = 'https://nauman-aziz.github.io/lybloo-social-autopost/tiktok/';
export const REDIRECT_URI = 'https://nauman-aziz.github.io/lybloo-social-autopost/tiktok-connect.html';
const MAX_PRODUCT_PHOTOS = 8;
const KEEP_PHOTO_SETS = 6;

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

// The store's product copy, as plain lines: specs, what's in the box, delivery terms.
function details(product) {
  return (product.body_html ?? '')
    .replace(/<li[^>]*>/g, '\n• ')
    .replace(/<\/(p|h\d|li|div)>|<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function caption(product) {
  const price = product.variants?.[0]?.price;
  const priceText = price ? `💰 Rs ${Number(price).toLocaleString('en-PK', { maximumFractionDigits: 0 })}` : '';
  const description = [
    `⚡ ${product.title}`,
    priceText,
    '',
    ...details(product),
    '',
    // TikTok won't show a website link on the profile until the business is verified, so point
    // straight at the store instead of a bio link.
    '🛍️ Order now on lybloo.com:',
    `https://lybloo.com/products/${product.handle}`,
    '',
    hashtags(product),
  ]
    .filter((line, i, lines) => line || lines[i - 1])
    .join('\n');
  // TikTok caps photo titles at 90 characters and descriptions at 4000.
  return { title: product.title.slice(0, 90), description: description.slice(0, 4000) };
}

// Writes the photo set into docs/tiktok/<product id>/ and records it in tiktok-pending.json for
// `send-pending` once the workflow has published it.
export async function preparePhotoPost(product, imageUrls) {
  const photos = [
    await buildStoryImage(product, imageUrls[0]),
    ...(await Promise.all(imageUrls.slice(1, 1 + MAX_PRODUCT_PHOTOS).map((url) => photoSlide(url, product.vendor ?? 'Lybloo')))),
    await ctaSlide(product),
  ];
  const dir = new URL(`${product.id}/`, PHOTOS_DIR);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const urls = [];
  for (const [i, photo] of photos.entries()) {
    const name = `${String(i + 1).padStart(2, '0')}.jpg`;
    await writeFile(new URL(name, dir), photo);
    urls.push(`${PHOTOS_URL}${product.id}/${name}`);
  }
  await writeFile(PENDING_FILE, JSON.stringify({ product_id: String(product.id), urls, ...caption(product) }, null, 2));
  console.log(`TikTok: prepared ${urls.length} photos, sent once published`);
  return caption(product);
}

// GitHub Pages takes a minute or two to publish a push.
async function waitUntilLive(urls) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const live = await Promise.all(urls.map((url) => fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false)));
    if (live.every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('photos did not appear on GitHub Pages within 10 minutes');
}

async function sendPhotoPost({ urls, title, description }) {
  const token = await accessToken();
  const { publish_id } = await api(token, '/post/publish/content/init/', {
    post_mode: 'MEDIA_UPLOAD',
    media_type: 'PHOTO',
    post_info: { title, description },
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: urls },
  });
  for (let attempt = 0; attempt < 24; attempt++) {
    const { status, fail_reason } = await api(token, '/post/publish/status/fetch/', { publish_id });
    if (status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE') return publish_id;
    if (status === 'FAILED') throw new Error(`TikTok photo post failed: ${fail_reason}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`TikTok photo post ${publish_id} still processing after 2 minutes`);
}

// Only the newest photo sets stay published; TikTok has copied them by the next run.
async function pruneOldPhotos(keepId) {
  const dirs = await readdir(PHOTOS_DIR).catch(() => []);
  const posted = JSON.parse(await readFile(POSTED_FILE, 'utf8').catch(() => '{}'));
  const age = (id) => posted[id]?.last_posted_at ?? '';
  const stale = dirs.filter((id) => id !== keepId).sort((a, b) => age(b).localeCompare(age(a))).slice(KEEP_PHOTO_SETS - 1);
  for (const id of stale) await rm(new URL(`${id}/`, PHOTOS_DIR), { recursive: true, force: true });
}

export async function sendPending() {
  const pending = JSON.parse(await readFile(PENDING_FILE, 'utf8'));
  let status = 'failed';
  try {
    await waitUntilLive(pending.urls);
    const id = await sendPhotoPost(pending);
    console.log(`TikTok: photo post sent to the inbox (${pending.urls.length} photos) ${id}`);
    status = 'sent';
  } catch (err) {
    console.log(`TikTok: FAILED ${err.message}`);
  }
  const posted = JSON.parse(await readFile(POSTED_FILE, 'utf8'));
  if (posted[pending.product_id]) {
    posted[pending.product_id].tiktok_status = status;
    await writeFile(POSTED_FILE, JSON.stringify(posted, null, 2) + '\n');
  }
  await rm(PENDING_FILE, { force: true });
  await pruneOldPhotos(pending.product_id);
  if (status === 'failed') process.exitCode = 1;
}

// `connect <code>` runs when a code is pasted into the workflow; `send-pending` runs after the
// photos are published.
const command = process.argv[2];
if (command === 'connect' || command === 'send-pending') {
  (command === 'connect' ? connect(process.argv[3]) : sendPending()).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
