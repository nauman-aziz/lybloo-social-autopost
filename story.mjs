// Builds the 1080x1920 story card for a product: the square product photo on a white card,
// with its name, price and a "link in bio" prompt, since API stories can't carry link stickers.
import sharp from 'sharp';

const WIDTH = 1080;
const HEIGHT = 1920;
// Instagram covers roughly the top 250px (progress bar, profile) and bottom 340px (reply box),
// so everything sits between those.
const PHOTO = 720;
const PHOTO_TOP = 440;
const ACCENT = '#0066cc';

const escape = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// SVG text doesn't wrap, so break the title into lines of roughly equal width ourselves.
function wrap(text, maxChars, maxLines) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

export async function buildStoryImage(product, imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`story image download: HTTP ${res.status}`);
  const photo = await sharp(Buffer.from(await res.arrayBuffer()))
    .resize(PHOTO - 80, PHOTO - 80, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .toBuffer();

  const title = wrap(product.title, 28, 3);
  const titleTop = PHOTO_TOP + PHOTO + 90;
  const price = product.variants?.[0]?.price;
  const priceText = price ? `Rs ${Number(price).toLocaleString('en-PK', { maximumFractionDigits: 0 })}` : '';
  const priceTop = titleTop + (title.length - 1) * 64 + 66;
  const pillTop = 1480;

  const overlay = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font-family: 'Inter', 'Segoe UI', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; }
  </style>
  <text x="${WIDTH / 2}" y="335" text-anchor="middle" font-size="60" font-weight="700" fill="#1d1d1f" letter-spacing="-1">Lybloo</text>
  <text x="${WIDTH / 2}" y="390" text-anchor="middle" font-size="30" fill="#6e6e73">New on the store</text>
  <rect x="${(WIDTH - PHOTO) / 2}" y="${PHOTO_TOP}" width="${PHOTO}" height="${PHOTO}" rx="48" fill="#ffffff"/>
  ${title
    .map(
      (line, i) =>
        `<text x="${WIDTH / 2}" y="${titleTop + i * 64}" text-anchor="middle" font-size="52" font-weight="700" fill="#1d1d1f" letter-spacing="-0.5">${escape(line)}</text>`,
    )
    .join('\n  ')}
  ${priceText ? `<text x="${WIDTH / 2}" y="${priceTop}" text-anchor="middle" font-size="42" fill="#6e6e73">${escape(priceText)}</text>` : ''}
  <rect x="${WIDTH / 2 - 310}" y="${pillTop}" width="620" height="100" rx="50" fill="${ACCENT}"/>
  <text x="${WIDTH / 2}" y="${pillTop + 64}" text-anchor="middle" font-size="38" font-weight="700" fill="#ffffff">Shop now · link in bio</text>
</svg>`;

  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#f5f5f7' } })
    .composite([
      { input: Buffer.from(overlay), top: 0, left: 0 },
      { input: photo, top: PHOTO_TOP + 40, left: (WIDTH - PHOTO) / 2 + 40 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}
