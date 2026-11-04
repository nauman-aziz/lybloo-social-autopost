// Picks five hashtags per product (Instagram's cap since late 2025): the store, the brand,
// the category, the most specific feature tag Shopify has, and a Pakistan tag that rotates so
// consecutive posts reach different hashtag feeds.

const CATEGORY_TAGS = {
  Chargers: '#FastCharger',
  Cables: '#USBCCable',
  'Power Banks': '#PowerBank',
  'Hands-free': '#Earphones',
  'Wireless Earbuds': '#WirelessEarbuds',
  Speakers: '#BluetoothSpeaker',
  Gaming: '#RetroGaming',
};

// Features worth a hashtag, most specific first, matched as whole words in tags and title.
const FEATURE_TAGS = [
  [/\bgan\b/, '#GaNCharger'],
  [/\blaptop charger\b/, '#LaptopCharger'],
  [/\bcar charger\b/, '#CarCharger'],
  [/\btype[- ]?c charger\b/, '#TypeCCharger'],
  [/\btws\b/, '#TWSEarbuds'],
  [/\bbluetooth earbuds\b/, '#BluetoothEarbuds'],
  [/\bwired earphones\b/, '#WiredEarphones'],
  [/\bwall charger\b/, '#WallCharger'],
  [/\bmobile charger\b/, '#MobileCharger'],
];

const PAKISTAN_TAGS = ['#TechPakistan', '#GadgetsPakistan', '#OnlineShoppingPakistan', '#MobileAccessoriesPakistan'];

const toHashtag = (text) => '#' + String(text).replace(/[^\p{L}\p{N}]+/gu, '');

export function hashtags(product) {
  const tags = new Set(['#Lybloo']);
  if (product.vendor) tags.add(toHashtag(product.vendor));
  if (CATEGORY_TAGS[product.product_type]) tags.add(CATEGORY_TAGS[product.product_type]);

  // Shopify tags are inconsistent across products, so the title counts as a tag source too.
  const haystack = [...(product.tags ?? []), product.title].join(' | ').toLowerCase();
  const feature = FEATURE_TAGS.find(([pattern, hashtag]) => pattern.test(haystack) && !tags.has(hashtag));
  if (feature) tags.add(feature[1]);

  // Shopify ids share remainders, so hash the digits to spread products across the Pakistan tags.
  let hash = 0;
  for (const digit of String(product.id)) hash = (hash * 31 + Number(digit)) % 1_000_003;
  for (let i = 0; tags.size < 5 && i < PAKISTAN_TAGS.length; i++) {
    tags.add(PAKISTAN_TAGS[(hash + i) % PAKISTAN_TAGS.length]);
  }
  return [...tags].slice(0, 5).join(' ');
}
