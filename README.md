# SeWeaves

Storefront and shop admin for SeWeaves (VSMA enterprise). Node + Express + SQLite.
No build step, no database server, no required configuration.

## Run it

```bash
npm install
npm run seed                 # optional sample catalogue
ADMIN_PASSWORD=letmein npm start
```

Shop at http://localhost:3000, admin at http://localhost:3000/admin.

It boots with zero environment variables. Without `ADMIN_PASSWORD` everything
works except signing in to the admin, and the log says so on startup.

## Deploy to Render (free)

1. Push this repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Build `npm ci`, Start `node server.js`, Instance **Free**, Region Singapore.
4. Environment:

| Key | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `ADMIN_PASSWORD` | long and random |
| `SHOP_WHATSAPP` | `919807338745` |

`NODE_VERSION` matters: `sharp` and `better-sqlite3` are native modules and
Node 22 has prebuilt binaries, so the build never falls back to compiling C++.

The boot log tells you it worked:

```
SeWeaves running on :10000
  root       /opt/render/project/src
  storefront found
Images: local disk ... — photos are lost when the host restarts
```

## The free-tier caveat

Render's free plan cannot attach a persistent disk, and the filesystem resets
whenever the service spins down (15 minutes idle), restarts, or redeploys. Your
catalogue and photos go with it. Free is for showing people the shop, not for
holding real stock.

Two ways to fix it when you're ready:

- **$7/mo Starter** — uncomment the `disk:` block in `render.yaml`, set
  `DATA_DIR=/var/data`. Nothing else changes, and the spin-down goes away too.
- **Free but persistent** — set the five `R2_*` variables and photos go to
  Cloudflare R2 (10 GB free, commercial use allowed). The SQLite file still
  needs a disk, so this solves half the problem.

## Ranking

One score, in `db.js`:

| Signal | Weight |
|---|---|
| Admin boost | 100 per point — always wins |
| Enquiries | 15 × log(1+n) |
| Views | 1.5 × log(1+n), throttled per visitor per 30 min |
| Rating | Bayesian, prior of 4.0 over 5 votes |
| Freshness | 30 → 0 over 45 days |
| Sold out | −250, sinks but stays findable |

Set boost 1–3 on window pieces, 0 on the rest. Editable inline in the admin table.
Reviews stay hidden until approved; approving is what moves the rating.

## Discounts

Two levels, and the product-specific one always wins — a piece you have
deliberately marked down is never further reduced by a seasonal offer.

**Store-wide.** Admin → Catalogue tab → *Store-wide discount*. Set a percentage
and it applies to every piece that has no discount of its own. Set it to 0 and
the offer banner disappears from the shop, so the site never advertises a
discount that is not actually being applied.

**Per piece.** In the add/edit form, choose *Percentage off* or *Flat amount off*
and enter a value. A live hint under the field shows exactly what the customer
will pay before you save.

The customer sees the original price struck through, the new price, and a
percentage badge on both the grid tile and the product page, plus the amount
saved in the bag.

Every price is recomputed server-side in `pricing.js`. `/api/orders` calls the
same function before writing the order, so editing prices in the browser
achieves nothing. Discounts are capped at 90% — a 100% discount is always a
mistake.

## Inline editing

The catalogue table is fully editable — title, price, discount, stock, boost and
live/hidden, all in the row. Changes accumulate locally with a gold marker on each
changed row, and a sticky bar shows how many pieces are pending. **Save all
changes** writes the lot in one request. Enter saves, Escape discards.

The *Customer pays* column recalculates as you type, using the same rules the
server applies, so you can see the effect of a discount before committing to it.

The whole batch is validated before anything is written, and the writes share one
transaction. A bad value in row seven means rows one to six are not written
either — you get one error and an unchanged catalogue, rather than a half-applied
edit you have to unpick. Values that are merely out of range (boost 99, a 150%
discount) are clamped rather than rejected.

Every field is editable in the table. The visible columns cover title, price,
discount, stock, boost and live/hidden; **Details** expands the row to reveal SKU,
collection, was-price, fabric, colour, work, blouse size and description. All of it
feeds the same batch save.

SKUs are checked for uniqueness both against the catalogue and within the batch, so
two rows cannot be given the same code in one edit.

**Photos** is the only thing that still opens its own screen — reordering and
uploading need more room than a table row allows.

## Photos

Up to 8 per piece. Stored twice — 1200×1600 for the product page, 500×667 for the
grid. **First photo is the cover.** Drag to reorder in the admin.

Customers get a thumbnail rail, 2.2× hover zoom, fullscreen lightbox, swipe on
phones, and arrow keys. The grid tile swaps to photo two on hover, so shoot the
pallu second.

## Prices are server-side

`/api/orders` re-reads every price from the database and ignores whatever the
browser sent. The cart is a convenience, not a source of truth.

## Backup

Everything is one file: `data/seweaves.db`.

```bash
cp data/seweaves.db ~/seweaves-$(date +%F).db
```
