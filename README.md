# Lybloo social autopost

Replaces the Make scenario "Lybloo Shopify → Instagram & Facebook". At 10:00 and 22:00 PKT, GitHub Actions
runs `post.mjs`. The script takes the first published product on lybloo.com that isn't in `posted.json`,
posts it to the Lybloo Facebook Page and @lybloopakistan on Instagram, and adds it to `posted.json`.

## One-time setup

### 1. Get a Meta Page access token

1. Go to https://developers.facebook.com → **My Apps → Create app** → choose type **Business**.
2. Add the products **Facebook Login for Business** and **Instagram Graph API**.
3. Open **Tools → Graph API Explorer**, select your app, and pick **User Token** with these permissions:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
   `instagram_content_publish`, `business_management`. Click **Generate Access Token** and approve.
4. Make it long-lived: open **Tools → Access Token Debugger**, paste the token, click **Extend Access Token**.
5. Back in the Explorer, with the long-lived user token, run `GET me/accounts`. Find the Lybloo Page in the
   result. Its `access_token` is your **PAGE_ACCESS_TOKEN**, which doesn't expire. Its `id` is your **FB_PAGE_ID**.
6. Run `GET <FB_PAGE_ID>?fields=instagram_business_account`. The `id` inside the result is your **IG_USER_ID**.

The app can stay in Development mode, because you are posting only to Pages you admin.

### 2. Put this folder on GitHub

Create a **private** repo, then from this folder run:

```bash
git init && git add . && git commit -m "Lybloo autopost" && git branch -M main
git remote add origin https://github.com/<you>/lybloo-social-autopost.git && git push -u origin main
```

Then go to **Settings → Secrets and variables → Actions** and add `PAGE_ACCESS_TOKEN`, `FB_PAGE_ID` and `IG_USER_ID`.

### 3. Carry over what Make already posted

Products Make already posted are stored in the Make data store `Lybloo_Posted_Products`, not here. Copy their keys
(the Shopify product IDs) into `posted.json`, for example `{"10377193750759": {}}`. Otherwise the first runs
post those products again.

### 4. Test

Go to **Actions → Lybloo autopost → Run workflow**. With "dry run" ticked, the run only prints the post it would make.
Untick it to post for real once. After that, the schedule runs by itself.

## Feed formats and hashtags

Runs alternate between two feed formats, both on Facebook and Instagram:

- **Reel** (`reel.mjs`): an ~12-second 1080×1920 video. It opens on the story card, shows up to three more product
  photos with a slow zoom, and ends on a price and "link in bio" card. It's rendered with ffmpeg and uploaded straight to
  Meta's resumable upload host. If a Reel fails, that platform gets the photos instead.
- **Carousel**: all the product's photos (up to 10) as one swipeable post (a multi-photo post on Facebook).

To force one format on a manual run, pick it in the **format** box when you click **Run workflow**.

`hashtags.mjs` picks five hashtags per product, Instagram's limit: #Lybloo, the brand, the category, the most specific
feature (GaN, car charger and so on), and a Pakistan tag that rotates between products.

## Stories

After the feed posts, `story.mjs` draws a 1080×1920 story card (product photo, name, price, "Shop now · link in bio"),
keeping everything clear of the areas Instagram covers at the top and bottom of a story. The card is uploaded to the Page
as an unpublished photo, posted as a Facebook Page story, and Instagram makes its story from Facebook's copy of the
image. Instagram doesn't let apps add link stickers to stories, so the card points to the bio link instead.

## Link in bio

Instagram captions can't hold clickable links, so the caption tells people to tap the bio link, which should be
https://lybloo.com/pages/instagram. That page is a grid of the Shopify collection `instagram`, newest post first, with live
prices and stock. It was created and seeded by `E:\lybloo\scripts\shopify\98-instagram-shop.js`.

After each Instagram post, `shopify.mjs` adds the product to that collection and moves it to the top. It needs three
more repository secrets, the same values as `E:\lybloo\.env.shopify`: `SHOPIFY_STORE`, `SHOPIFY_CLIENT_ID` and
`SHOPIFY_CLIENT_SECRET`. Without them the step is skipped and logged, and posting still works.

The script also still rebuilds `docs/index.html`, the older GitHub Pages version of this grid at
https://nauman-aziz.github.io/lybloo-social-autopost/. It copies prices at posting time, so they go stale.

## Instagram product tags

Not available for Lybloo as of November 2026: Meta only offers Shops and product tagging to businesses in its
[supported countries](https://www.facebook.com/business/help/549256849084694), and Pakistan isn't one. The code stays in
case that changes; it checks eligibility on every run and posts untagged when the account isn't eligible.

When eligible, the script tags the product on the Instagram photo, so tapping it opens that product on lybloo.com. This needs:

- An approved Instagram Shop for @lybloopakistan, with the Shopify catalog connected through the Shopify
  "Facebook & Instagram" sales channel (set up in Commerce Manager).
- The `instagram_shopping_tag_products` and `catalog_management` permissions on the token.
- Optional: a `CATALOG_ID` secret. Without it, the script uses the first catalog connected to the Instagram account.

When any of these is missing, or the product isn't approved in the catalog yet, the script posts without a tag and logs why.

## Notes

- Locally: `DRY_RUN=1 node post.mjs` (Node 20 or newer).
- When every product has been posted, the runs log "Nothing new to post". To start over, empty `posted.json`.
- GitHub can delay scheduled runs by a few minutes, and it pauses schedules in repos with no activity for 60 days.
  The bot's commit after each post counts as activity, so this only matters once every product has been posted.
