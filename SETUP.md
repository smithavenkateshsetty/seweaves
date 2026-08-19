# Making SeWeaves persist — free

Two separate problems. The database and the photos each need their own home,
because Render's free plan gives you neither.

---

## 1. Database — Neon Postgres (free, does not expire)

1. Sign up at https://neon.tech with GitHub. No card needed.
2. Create a project. Name it `seweaves`, region **Singapore** (closest to India).
3. On the dashboard, find **Connection string** and pick the **Pooled connection**
   from the dropdown. It looks like:

   ```
   postgresql://user:PASSWORD@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

   Take the **pooled** one, not the direct one. Neon's free tier caps
   connections, and pooling is what keeps you under it.

4. In Render → your service → **Environment** → add:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the pooled string you just copied |

That is the whole database migration. The app creates its own tables on boot.
Nothing to run by hand.

**Check it worked.** Render → Logs, after redeploy:

```
Database: Postgres — your catalogue survives restarts
```

If it says `SQLite file`, `DATABASE_URL` did not reach the app.

---

## 2. Photos — Cloudinary (free 25 GB, no card)

Neon holds the catalogue but not the images. Without this step your photos still
vanish on restart.

Do not put images in Postgres. Neon's free plan is 0.5 GB of storage and 5 GB of
monthly transfer — 200 sarees at five photos each would eat half the database and
burn the month's bandwidth in a few hundred visits.

1. Sign up at https://cloudinary.com — free, no card.
2. The dashboard shows **Cloud name**, **API Key** and **API Secret**. Click to
   reveal the secret.
3. Add three variables in Render:

| Key | Value |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | your cloud name |
| `CLOUDINARY_API_KEY` | the API key |
| `CLOUDINARY_API_SECRET` | the API secret |

Optionally `CLOUDINARY_FOLDER` (defaults to `seweaves`) to keep uploads tidy.

**Check it worked.** The log line changes to:

```
Images: Cloudinary (yourcloud/seweaves) — photos survive restarts
```

Uploads are signed server-side, so the API secret never reaches the browser.

If a photo fails to upload you get the real reason, not a generic error — e.g.
`Could not save the photo to Cloudinary (...): Invalid Signature`. That almost
always means the API secret is wrong or has a stray space.

Photos uploaded before this switch still point at `/uploads/...` and will break.
Re-upload them, or start clean.

### Cloudflare R2 instead

If you would rather use R2 (10 GB free, but requires a card on file), set
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and
`R2_PUBLIC_URL`. Cloudinary takes precedence if both are set.

---

## What you end up with

| Piece | Where | Cost | Persists |
|---|---|---|---|
| App | Render free | ₹0 | n/a — restarts are fine now |
| Catalogue, orders, reviews | Neon | ₹0 | yes |
| Photos | Cloudinary | ₹0 | yes |

Still true on the free plan: the service sleeps after 15 minutes idle, so the
first visitor waits up to a minute. Only the $7 Starter plan fixes that.

Still not solved: taking money. This takes WhatsApp enquiries, not card or UPI
payments.

---

## Running locally

Nothing to configure. With no `DATABASE_URL`, it uses a SQLite file in `data/`.

```bash
npm install
npm run seed
ADMIN_PASSWORD=letmein npm start
```

To test against Neon from your laptop, put the same connection string in `.env`
or pass it inline.

## Backups

Neon keeps point-in-time history on the free tier, but take your own too:

```bash
pg_dump "$DATABASE_URL" > seweaves-$(date +%F).sql
```
