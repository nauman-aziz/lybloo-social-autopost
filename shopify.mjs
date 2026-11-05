// Keeps lybloo.com/pages/instagram in step with the Instagram feed.
//
// That page renders the manual collection `instagram` in its stored order, so "newest post
// first" means: add the product, then move it to position 0. Created by
// E:\lybloo\scripts\shopify\98-instagram-shop.js, which also seeded the earlier posts.
//
// Credentials are the Shopify Dev Dashboard app "Lybloo Build" (the same values as
// E:\lybloo\.env.shopify), stored as the GitHub secrets SHOPIFY_STORE, SHOPIFY_CLIENT_ID and
// SHOPIFY_CLIENT_SECRET. Dev Dashboard apps issue 24-hour tokens through the
// client_credentials grant, so each run mints a fresh one.
const API_VERSION = '2026-07';
const COLLECTION_HANDLE = 'instagram';

const { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;

async function adminToken() {
  const res = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function gql(token, query, variables) {
  const res = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`Shopify: ${JSON.stringify(body.errors ?? body)}`);
  // Shopify reports rejected mutations as userErrors inside an HTTP 200.
  for (const value of Object.values(body.data ?? {})) {
    if (value?.userErrors?.length) throw new Error(`Shopify: ${JSON.stringify(value.userErrors)}`);
  }
  return body.data;
}

export async function addToFeedPage(productId) {
  if (!SHOPIFY_STORE || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('SHOPIFY_STORE / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set');
  }
  const token = await adminToken();
  const product = `gid://shopify/Product/${productId}`;
  const found = await gql(token, 'query($h:String!,$p:ID!){ collectionByHandle(handle:$h){ id hasProduct(id:$p) } }', {
    h: COLLECTION_HANDLE,
    p: product,
  });
  const collection = found.collectionByHandle;
  if (!collection) throw new Error(`no collection with handle ${COLLECTION_HANDLE}`);
  if (!collection.hasProduct) {
    await gql(token, 'mutation($id:ID!,$p:[ID!]!){ collectionAddProducts(id:$id, productIds:$p){ userErrors{ field message } } }', {
      id: collection.id,
      p: [product],
    });
  }
  await gql(
    token,
    'mutation($id:ID!,$m:[MoveInput!]!){ collectionReorderProducts(id:$id, moves:$m){ job{ id } userErrors{ field message } } }',
    { id: collection.id, m: [{ id: product, newPosition: '0' }] },
  );
}
