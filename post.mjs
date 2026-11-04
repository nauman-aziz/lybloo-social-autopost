// Replacement for the Make scenario "Lybloo Shopify → Instagram & Facebook".
// Each run posts ONE published product that hasn't been posted yet to the
// Lybloo Facebook Page and Instagram Business account, then records it in posted.json.
import { readFile, writeFile } from 'node:fs/promises';
import { hashtags } from './hashtags.mjs';
import { renderLinkPage } from './links.mjs';
import { buildReel } from './reel.mjs';
import { buildStoryImage } from './story.mjs';

const STORE_URL = 'https://lybloo.com';
const STATE_FILE = new URL('./posted.json', import.meta.url);
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v26.0'}`;
const DRY_RUN = process.env.DRY_RUN === '1';

const { FB_PAGE_ID, IG_USER_ID } = process.env;
let PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

function caption(product) {
  return [
    `⚡ Discover ${product.title} at Lybloo!`,
    '',
    '🛍️ Shop now:',
    `${STORE_URL}/products/${product.handle}`,
    '',
    hashtags(product),
  ].join('\n');
}

// Shopify rate-limits products.json in bursts, so back off and retry before giving up.
async function fetchJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt === 4) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 15000));
  }
}

async function fetchProducts() {
  const products = [];
  for (let page = 1; ; page++) {
    const batch = (await fetchJson(`${STORE_URL}/products.json?limit=250&page=${page}`)).products;
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

async function graphGet(path, params = {}) {
  const query = new URLSearchParams({ ...params, access_token: PAGE_ACCESS_TOKEN });
  const body = await (await fetch(`${GRAPH}/${path}?${query}`)).json();
  if (body.error) throw new Error(`${path}: ${body.error.message}`);
  return body;
}

// Finds the Instagram Shop catalog item for a Shopify product so the IG post can carry a
// tappable product tag that opens it on lybloo.com. Returns null (post untagged) when the
// account isn't eligible or the product isn't approved in the catalog yet.
async function findProductTag(product) {
  try {
    const { shopping_product_tag_eligibility } = await graphGet(IG_USER_ID, { fields: 'shopping_product_tag_eligibility' });
    if (!shopping_product_tag_eligibility) {
      console.log('Product tag: skipped, the Instagram account is not eligible for Instagram Shopping tags.');
      return null;
    }

    const catalogId = process.env.CATALOG_ID || (await graphGet(`${IG_USER_ID}/available_catalogs`)).data?.[0]?.catalog_id;
    if (!catalogId) {
      console.log('Product tag: skipped, no catalog is connected to the Instagram Shop.');
      return null;
    }

    const { data = [] } = await graphGet(`${IG_USER_ID}/catalog_product_search`, { catalog_id: catalogId, q: product.title });
    // The Shopify Facebook & Instagram channel puts the Shopify product id inside retailer_id.
    const match =
      data.find((p) => p.retailer_id?.includes(String(product.id))) ?? data.find((p) => p.product_name === product.title);
    if (!match) {
      console.log(`Product tag: skipped, "${product.title}" not found in catalog ${catalogId}.`);
      return null;
    }
    if (match.review_status && match.review_status !== 'approved') {
      console.log(`Product tag: skipped, catalog item ${match.product_id} is "${match.review_status}".`);
      return null;
    }

    console.log(`Product tag: catalog item ${match.product_id} (${match.retailer_id}).`);
    return { product_id: match.product_id, x: 0.5, y: 0.8 };
  } catch (err) {
    console.log(`Product tag: skipped, ${err.message}`);
    return null;
  }
}

async function postToInstagram(imageUrl, text, tag) {
  let containerId;
  try {
    ({ id: containerId } = await graph(`${IG_USER_ID}/media`, {
      image_url: imageUrl,
      caption: text,
      ...(tag && { product_tags: JSON.stringify([tag]) }),
    }));
  } catch (err) {
    if (!tag) throw err;
    console.log(`Product tag rejected, posting without it: ${err.message}`);
    ({ id: containerId } = await graph(`${IG_USER_ID}/media`, { image_url: imageUrl, caption: text }));
  }

  return publishInstagram(containerId);
}

async function publishInstagram(containerId, attempts = 12) {
  await waitForContainer(containerId, attempts);
  const { id } = await graph(`${IG_USER_ID}/media_publish`, { creation_id: containerId });
  return id;
}

// Instagram fetches and processes media asynchronously; publishing before it finishes fails.
async function waitForContainer(containerId, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { status_code, status } = await graphGet(containerId, { fields: 'status_code,status' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`IG container ${status_code}: ${status ?? ''}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`IG container ${containerId} still processing after ${attempts * 5}s`);
}

// Carousels: every product photo (up to Instagram's 10) as one swipeable post.
async function postInstagramCarousel(imageUrls, text) {
  const children = [];
  for (const url of imageUrls) {
    const { id } = await graph(`${IG_USER_ID}/media`, { image_url: url, is_carousel_item: 'true' });
    children.push(id);
  }
  for (const id of children) await waitForContainer(id);
  const { id } = await graph(`${IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: text });
  return publishInstagram(id);
}

async function postFacebookAlbum(imageUrls, text) {
  const attached = [];
  for (const url of imageUrls) {
    const { id } = await graph(`${FB_PAGE_ID}/photos`, { url, published: 'false' });
    attached.push({ media_fbid: id });
  }
  const params = { message: text };
  attached.forEach((media, i) => (params[`attached_media[${i}]`] = JSON.stringify(media)));
  const { id } = await graph(`${FB_PAGE_ID}/feed`, params);
  return id;
}

// Sends a local file to Meta's resumable upload host, used by both Reels endpoints.
async function rupload(url, video) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `OAuth ${PAGE_ACCESS_TOKEN}`, offset: '0', file_size: String(video.length) },
    body: video,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || body.success === false) throw new Error(`video upload: ${JSON.stringify(body.error ?? body)}`);
}

async function postInstagramReel(video, text) {
  const { id, uri } = await graph(`${IG_USER_ID}/media`, {
    media_type: 'REELS',
    upload_type: 'resumable',
    caption: text,
    share_to_feed: 'true',
  });
  await rupload(uri ?? `https://rupload.facebook.com/ig-api-upload/${GRAPH.split('/').pop()}/${id}`, video);
  return publishInstagram(id, 60);
}

async function postFacebookReel(video, text) {
  const { video_id, upload_url } = await graph(`${FB_PAGE_ID}/video_reels`, { upload_phase: 'start' });
  await rupload(upload_url, video);
  await graph(`${FB_PAGE_ID}/video_reels`, {
    upload_phase: 'finish',
    video_id,
    video_state: 'PUBLISHED',
    description: text,
  });
  return video_id;
}

// Uploads the story card to the Page as an unpublished photo. Facebook's story is made from
// that photo, and Instagram (which needs a public URL) fetches Facebook's copy of it.
async function uploadStoryImage(image) {
  const form = new FormData();
  form.append('source', new Blob([image], { type: 'image/jpeg' }), 'story.jpg');
  form.append('published', 'false');
  form.append('access_token', PAGE_ACCESS_TOKEN);
  const body = await (await fetch(`${GRAPH}/${FB_PAGE_ID}/photos`, { method: 'POST', body: form })).json();
  if (body.error) throw new Error(`story upload: ${body.error.message}`);

  const { images = [] } = await graphGet(body.id, { fields: 'images' });
  const largest = images.reduce((a, b) => (b.width > (a?.width ?? 0) ? b : a), null);
  if (!largest) throw new Error('story upload: Facebook returned no image URL');
  return { photoId: body.id, url: largest.source };
}

async function postFacebookStory(photoId) {
  const { post_id, id } = await graph(`${FB_PAGE_ID}/photo_stories`, { photo_id: photoId });
  return post_id ?? id;
}

async function postInstagramStory(url) {
  const { id: containerId } = await graph(`${IG_USER_ID}/media`, { media_type: 'STORIES', image_url: url });
  return publishInstagram(containerId);
}

// Facebook only lets a Page token publish to the Page. The secret may hold the user token it was
// minted from, so swap it for the Page's own token; a Page token passed in comes back unchanged.
async function usePageToken() {
  const { access_token: pageToken } = await graphGet(FB_PAGE_ID, { fields: 'access_token' });
  if (pageToken) PAGE_ACCESS_TOKEN = pageToken;

  const { data } = await graphGet('debug_token', { input_token: PAGE_ACCESS_TOKEN });
  const expires = data?.expires_at ? new Date(data.expires_at * 1000).toISOString() : 'never';
  console.log(`Using a ${data?.type ?? 'unknown'} token for ${data?.profile_id ?? FB_PAGE_ID}, expires: ${expires}`);
}

// Shopify's CDN serves WebP to clients that accept it, which Instagram rejects; pjpg forces a JPEG.
function jpegUrl(src) {
  const url = new URL(src);
  url.searchParams.set('format', 'pjpg');
  return url.href;
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

  const imageUrl = jpegUrl(product.images[0].src);
  if (PAGE_ACCESS_TOKEN) await usePageToken();
  const text = caption(product);
  console.log(`Posting "${product.title}" (${product.id})\nImage: ${imageUrl}\n---\n${text}\n---`);
  const tag = PAGE_ACCESS_TOKEN ? await findProductTag(product) : null;
  // Links in Instagram captions aren't clickable, so point people at the product tag or the bio link instead.
  const igText = text.replace(
    '🛍️ Shop now:',
    tag ? '🛍️ Tap the photo to shop, or visit:' : '🛍️ Tap the link in our bio to shop this product, or visit:',
  );
  const imageUrls = product.images.slice(0, 10).map((image) => jpegUrl(image.src));
  // Alternate formats so followers see a mix: Reels reach non-followers, carousels earn swipes.
  const format = process.env.FORMAT || (Object.keys(posted).length % 2 === 0 ? 'reel' : 'carousel');
  const storyImage = await buildStoryImage(product, imageUrl);
  const video = format === 'reel' ? await buildReel(product, imageUrls) : null;
  console.log(`Format: ${format}, ${imageUrls.length} photo(s)${video ? `, reel ${Math.round(video.length / 1024)} KB` : ''}`);
  if (DRY_RUN) {
    console.log(`Story card built: ${Math.round(storyImage.length / 1024)} KB`);
    if (PAGE_ACCESS_TOKEN) await checkAccess();
    return;
  }

  // A carousel needs two photos; a product tag only works on a single photo.
  const facebookGallery = () => (imageUrls.length > 1 ? postFacebookAlbum(imageUrls, text) : postToFacebook(imageUrl, text));
  const instagramGallery = () =>
    imageUrls.length > 1 && !tag ? postInstagramCarousel(imageUrls, igText) : postToInstagram(imageUrl, igText, tag);
  // If a Reel fails (video processing is the flakiest step), fall back to the photos so the product still goes out.
  const withFallback = async (name, reel, gallery) => {
    if (!video) return gallery();
    try {
      return await reel();
    } catch (err) {
      console.log(`${name} reel failed, posting photos instead: ${err.message}`);
      return gallery();
    }
  };

  const record = {
    product_title: product.title,
    handle: product.handle,
    image: imageUrl,
    price: product.variants?.[0]?.price,
    last_posted_at: new Date().toISOString(),
    cycle_number: 1,
    format,
  };
  const results = await Promise.allSettled([
    withFallback('Facebook', () => postFacebookReel(video, text), facebookGallery),
    withFallback('Instagram', () => postInstagramReel(video, igText), instagramGallery),
  ]);
  const [facebook, instagram] = results.map((r) => (r.status === 'fulfilled' ? 'posted' : 'failed'));
  results.forEach((r, i) => {
    const name = i === 0 ? 'Facebook' : 'Instagram';
    console.log(r.status === 'fulfilled' ? `${name}: posted ${r.value}` : `${name}: FAILED ${r.reason.message}`);
  });

  let facebookStory = 'failed';
  let instagramStory = 'failed';
  try {
    const story = await uploadStoryImage(storyImage);
    const stories = await Promise.allSettled([postFacebookStory(story.photoId), postInstagramStory(story.url)]);
    [facebookStory, instagramStory] = stories.map((r) => (r.status === 'fulfilled' ? 'posted' : 'failed'));
    stories.forEach((r, i) => {
      const name = i === 0 ? 'Facebook story' : 'Instagram story';
      console.log(r.status === 'fulfilled' ? `${name}: posted ${r.value}` : `${name}: FAILED ${r.reason.message}`);
    });
  } catch (err) {
    console.log(`Stories: FAILED ${err.message}`);
  }

  // Record the product if either platform got it, so a one-sided failure doesn't double-post the other.
  if (facebook === 'posted' || instagram === 'posted') {
    posted[product.id] = {
      ...record,
      facebook_status: facebook,
      instagram_status: instagram,
      facebook_story_status: facebookStory,
      instagram_story_status: instagramStory,
    };
    await writeFile(STATE_FILE, JSON.stringify(posted, null, 2) + '\n');
    await renderLinkPage(posted);
  }
  if ([facebook, instagram, facebookStory, instagramStory].includes('failed')) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
