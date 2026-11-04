// Replacement for the Make scenario "Lybloo Shopify → Instagram & Facebook".
// Each run posts ONE published product that hasn't been posted yet to the
// Lybloo Facebook Page and Instagram Business account, then records it in posted.json.
import { readFile, writeFile } from 'node:fs/promises';

const STORE_URL = 'https://lybloo.com';
const STATE_FILE = new URL('./posted.json', import.meta.url);
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v26.0'}`;
const DRY_RUN = process.env.DRY_RUN === '1';

const { PAGE_ACCESS_TOKEN, FB_PAGE_ID, IG_USER_ID } = process.env;

function caption(product) {
  return [
    `⚡ Discover ${product.title} at Lybloo!`,
    '',
    '🛍️ Shop now:',
    `${STORE_URL}/products/${product.handle}`,
    '',
    '#Lybloo #TechAccessories #GadgetsPakistan',
  ].join('\n');
}

async function fetchProducts() {
  const products = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${STORE_URL}/products.json?limit=250&page=${page}`);
    if (!res.ok) throw new Error(`products.json page ${page}: HTTP ${res.status}`);
    const batch = (await res.json()).products;
    if (!batch.length) break;
    products.push(...batch);
    if (batch.length < 250) break;
  }
  return products;
}

async function graph(path, params) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    body: new URLSearchParams({ ...params, access_token: PAGE_ACCESS_TOKEN }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`${path}: ${JSON.stringify(body.error ?? body)}`);
  return body;
}

async function postToFacebook(imageUrl, text) {
  const { post_id, id } = await graph(`${FB_PAGE_ID}/photos`, { url: imageUrl, message: text });
  return post_id ?? id;
}

async function postToInstagram(imageUrl, text) {
  const { id: containerId } = await graph(`${IG_USER_ID}/media`, { image_url: imageUrl, caption: text });

  // Instagram fetches the image asynchronously; publishing before it finishes fails.
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(`${GRAPH}/${containerId}?fields=status_code&access_token=${PAGE_ACCESS_TOKEN}`);
    const { status_code } = await res.json();
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`IG container ${status_code}`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  const { id } = await graph(`${IG_USER_ID}/media_publish`, { creation_id: containerId });
  return id;
}

// Read-only check that the token can see both accounts; used by dry runs.
async function checkAccess() {
  for (const [label, path] of [['Facebook Page', `${FB_PAGE_ID}?fields=name`], ['Instagram', `${IG_USER_ID}?fields=username`]]) {
    const res = await fetch(`${GRAPH}/${path}&access_token=${PAGE_ACCESS_TOKEN}`);
    const body = await res.json();
    if (body.error) throw new Error(`${label} access check failed: ${body.error.message}`);
    console.log(`${label} access OK: ${body.name ?? body.username}`);
  }
}

async function main() {
  if (!DRY_RUN && !(PAGE_ACCESS_TOKEN && FB_PAGE_ID && IG_USER_ID)) {
    throw new Error('Set PAGE_ACCESS_TOKEN, FB_PAGE_ID and IG_USER_ID (or DRY_RUN=1).');
  }

  const posted = JSON.parse(await readFile(STATE_FILE, 'utf8').catch(() => '{}'));
  const products = await fetchProducts();
  const product = products.find((p) => p.published_at && p.images?.length && !posted[p.id]);

  console.log(`${products.length} products, ${Object.keys(posted).length} already posted.`);
  if (!product) {
    console.log('Nothing new to post.');
    return;
  }

  const imageUrl = product.images[0].src;
  const text = caption(product);
  console.log(`Posting "${product.title}" (${product.id})\nImage: ${imageUrl}\n---\n${text}\n---`);
  if (DRY_RUN) {
    if (PAGE_ACCESS_TOKEN) await checkAccess();
    return;
  }

  const record = { product_title: product.title, last_posted_at: new Date().toISOString(), cycle_number: 1 };
  const results = await Promise.allSettled([postToFacebook(imageUrl, text), postToInstagram(imageUrl, text)]);
  const [facebook, instagram] = results.map((r) => (r.status === 'fulfilled' ? 'posted' : 'failed'));
  results.forEach((r, i) => {
    const name = i === 0 ? 'Facebook' : 'Instagram';
    console.log(r.status === 'fulfilled' ? `${name}: posted ${r.value}` : `${name}: FAILED ${r.reason.message}`);
  });

  // Record the product if either platform got it, so a one-sided failure doesn't double-post the other.
  if (facebook === 'posted' || instagram === 'posted') {
    posted[product.id] = { ...record, facebook_status: facebook, instagram_status: instagram };
    await writeFile(STATE_FILE, JSON.stringify(posted, null, 2) + '\n');
  }
  if (facebook === 'failed' || instagram === 'failed') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
