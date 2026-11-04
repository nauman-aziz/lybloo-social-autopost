// Renders a ~12s 1080x1920 Reel for a product: the story card as the opener, up to three more
// product photos, then a price / call-to-action card. Each slide slowly zooms and crossfades into
// the next. The audio track is silent; Instagram rejects some uploads that have none.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import { buildStoryImage } from './story.mjs';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const SLIDE_SECONDS = 2.6;
const FADE_SECONDS = 0.4;
const MAX_PHOTOS = 3;
const ACCENT = '#0066cc';
const FONT = "'Inter', 'Segoe UI', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

const run = promisify(execFile);
const escape = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reel image download: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function background(svg) {
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#f5f5f7' } }).composite([
    { input: Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`) },
  ]);
}

async function photoSlide(imageUrl, vendor) {
  const size = 900;
  const photo = await sharp(await download(imageUrl))
    .resize(size - 80, size - 80, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .toBuffer();
  const top = (HEIGHT - size) / 2;
  const card = await background(`
    <rect x="${(WIDTH - size) / 2}" y="${top}" width="${size}" height="${size}" rx="48" fill="#ffffff"/>
    <text x="${WIDTH / 2}" y="${top - 60}" text-anchor="middle" font-family="${FONT}" font-size="44" font-weight="700" fill="#1d1d1f">${escape(vendor)}</text>`)
    .png()
    .toBuffer();
  return sharp(card)
    .composite([{ input: photo, top: top + 40, left: (WIDTH - size) / 2 + 40 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function ctaSlide(product) {
  const price = product.variants?.[0]?.price;
  const priceText = price ? `Rs ${Number(price).toLocaleString('en-PK', { maximumFractionDigits: 0 })}` : '';
  return background(`
    <text x="${WIDTH / 2}" y="640" text-anchor="middle" font-family="${FONT}" font-size="64" font-weight="700" fill="#1d1d1f">Lybloo</text>
    ${priceText ? `<text x="${WIDTH / 2}" y="900" text-anchor="middle" font-family="${FONT}" font-size="120" font-weight="700" fill="#1d1d1f" letter-spacing="-2">${escape(priceText)}</text>` : ''}
    <rect x="${WIDTH / 2 - 330}" y="1120" width="660" height="110" rx="55" fill="${ACCENT}"/>
    <text x="${WIDTH / 2}" y="1190" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="700" fill="#ffffff">Shop now · link in bio</text>
    <text x="${WIDTH / 2}" y="1300" text-anchor="middle" font-family="${FONT}" font-size="36" fill="#6e6e73">lybloo.com</text>`)
    .jpeg({ quality: 90 })
    .toBuffer();
}

// imageUrls must already be JPEG URLs (see jpegUrl in post.mjs).
export async function buildReel(product, imageUrls) {
  const slides = [
    await buildStoryImage(product, imageUrls[0]),
    ...(await Promise.all(imageUrls.slice(1, 1 + MAX_PHOTOS).map((url) => photoSlide(url, product.vendor ?? 'Lybloo')))),
    await ctaSlide(product),
  ];

  const dir = await mkdtemp(join(tmpdir(), 'lybloo-reel-'));
  try {
    const inputs = [];
    for (const [i, slide] of slides.entries()) {
      const file = join(dir, `slide-${i}.jpg`);
      await writeFile(file, slide);
      inputs.push('-i', file);
    }

    const frames = Math.round(SLIDE_SECONDS * FPS);
    const total = slides.length * SLIDE_SECONDS - (slides.length - 1) * FADE_SECONDS;
    // Zooming an upscaled frame keeps the slow zoom from shimmering.
    const zooms = slides.map(
      (_, i) =>
        `[${i}:v]scale=${WIDTH * 2}:${HEIGHT * 2},zoompan=z='min(zoom+0.0007,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1,format=yuv420p[v${i}]`,
    );
    const fades = [];
    let last = 'v0';
    for (let i = 1; i < slides.length; i++) {
      const offset = (i * (SLIDE_SECONDS - FADE_SECONDS)).toFixed(2);
      fades.push(`[${last}][v${i}]xfade=transition=fade:duration=${FADE_SECONDS}:offset=${offset}[x${i}]`);
      last = `x${i}`;
    }

    const out = join(dir, 'reel.mp4');
    await run(
      ffmpeg,
      [
        '-y',
        ...inputs,
        '-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo',
        '-filter_complex', [...zooms, ...fades].join(';'),
        '-map', `[${last}]`, '-map', `${slides.length}:a`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
        out,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
