import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  q, one, migrate, listProducts, getProduct, facets, uniqueSlug, pool
} from './db.js';
import * as storage from './storage.js';

// Resolve from this file, not the working directory. Hosts don't guarantee cwd.
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SHOP_WHATSAPP = process.env.SHOP_WHATSAPP || '91XXXXXXXXXX';
const DAY = 24 * 60 * 60 * 1000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/* Async handlers need their rejections forwarded, or a failed query hangs the
 * request instead of returning a 500. Express 4 does not do this itself. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* --------------------------- admin sessions ------------------------ */
async function validSession(token) {
  if (!token) return false;
  const row = await one(
    'SELECT 1 FROM sessions WHERE token = @token AND expires_at > now()', { token });
  return Boolean(row);
}

const requireAdmin = wrap(async (req, res, next) => {
  if (await validSession(req.cookies.sw_admin)) return next();
  res.status(401).json({ error: 'Sign in to continue.' });
});

app.post('/api/admin/login', wrap(async (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not set on the server.' });
  }
  const supplied = Buffer.from(String(req.body.password || ''));
  const actual = Buffer.from(ADMIN_PASSWORD);
  const ok = supplied.length === actual.length && crypto.timingSafeEqual(supplied, actual);
  if (!ok) return res.status(401).json({ error: 'That password does not match.' });

  const token = crypto.randomBytes(24).toString('hex');
  await q(`INSERT INTO sessions (token, expires_at) VALUES (@token, now() + interval '7 days')`,
    { token });
  await q('DELETE FROM sessions WHERE expires_at < now()');

  res.cookie('sw_admin', token, {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * DAY,
    secure: process.env.NODE_ENV === 'production'
  });
  res.json({ ok: true });
}));

app.post('/api/admin/logout', wrap(async (req, res) => {
  await q('DELETE FROM sessions WHERE token = @token', { token: req.cookies.sw_admin || '' });
  res.clearCookie('sw_admin').json({ ok: true });
}));

app.get('/api/admin/me', wrap(async (req, res) =>
  res.json({ signedIn: await validSession(req.cookies.sw_admin) })));

/* ------------------------------ uploads ---------------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) =>
    /^image\/(jpeg|png|webp|avif)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Upload a JPEG, PNG, WebP or AVIF image.'))
});

function receiveImages(req, res, next) {
  upload.array('images', 8)(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'That image is over 12 MB. Resize it and try again.'
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'Eight photos per piece is the limit.'
        : err.message || 'That file could not be read.';
    res.status(400).json({ error: msg });
  });
}

// Sarees are tall. 1200x1600 keeps the zari legible under 2.2x zoom; the
// 500x667 thumbnail is what the grid and the gallery rail actually load.
app.post('/api/admin/upload', requireAdmin, receiveImages, wrap(async (req, res) => {
  const out = [];
  try {
  for (const file of req.files || []) {
    const name = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const [full, thumb] = await Promise.all([
      sharp(file.buffer).rotate()
        .resize(1200, 1600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer(),
      sharp(file.buffer).rotate()
        .resize(500, 667, { fit: 'cover' })
        .webp({ quality: 74 }).toBuffer()
    ]);
    const [url] = await Promise.all([
      storage.put(`${name}.webp`, full),
      storage.put(`${name}-thumb.webp`, thumb)
    ]);
    out.push(url);
  }
  } catch (err) {
    // Storage failures are configuration problems nine times out of ten.
    // Say which backend failed and why, rather than a generic 500.
    console.error('Upload failed:', err);
    return res.status(502).json({
      error: `Could not save the photo to ${storage.describeStorage().split(' —')[0]}: ${err.message}`
    });
  }
  res.json({ images: out });
}));

// Only mounted when running on local disk. With Cloudinary or R2 the images
// are served from their CDN and never touch this process.
if (!storage.usingR2 && !storage.usingCloudinary) {
  app.use('/uploads', express.static(storage.LOCAL_DIR, { maxAge: '30d', immutable: true }));
}

/* --------------------------- public catalogue ---------------------- */
app.get('/api/products', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(48, parseInt(req.query.limit) || 12);
  res.json(await listProducts({
    q: String(req.query.q || '').slice(0, 80),
    collection: String(req.query.collection || '').slice(0, 30),
    sort: String(req.query.sort || 'recommended'),
    minPrice: parseInt(req.query.min) || 0,
    maxPrice: parseInt(req.query.max) || 0,
    inStock: req.query.inStock === '1',
    limit, offset: (page - 1) * limit
  }));
}));

app.get('/api/facets', wrap(async (_req, res) => res.json(await facets())));
app.get('/api/shop', (_req, res) => res.json({ whatsapp: SHOP_WHATSAPP }));

const viewed = new Map();   // per-process throttle so refreshes don't inflate rank
app.get('/api/products/:slug', wrap(async (req, res) => {
  const product = await getProduct(req.params.slug);
  if (!product) return res.status(404).json({ error: 'That piece is no longer listed.' });

  const key = `${req.ip}:${product.id}`;
  if (!viewed.has(key) || Date.now() - viewed.get(key) > 30 * 60 * 1000) {
    viewed.set(key, Date.now());
    await q('UPDATE products SET views = views + 1 WHERE id = @id', { id: product.id });
  }
  res.json(product);
}));

app.post('/api/products/:slug/reviews', wrap(async (req, res) => {
  const product = await getProduct(req.params.slug);
  if (!product) return res.status(404).json({ error: 'That piece is no longer listed.' });

  const rating = parseInt(req.body.rating);
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Add your name.' });
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });

  // Held until approved — the rating only moves the ranking once you say so.
  await q(`INSERT INTO reviews (product_id, name, rating, body)
           VALUES (@pid, @name, @rating, @body)`,
    { pid: product.id, name, rating, body: String(req.body.body || '').slice(0, 800) });
  res.json({ ok: true, held: true });
}));

/* ------------------------------ orders ----------------------------- */
app.post('/api/orders', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = String(req.body.phone || '').trim().slice(0, 20);
  const cart = Array.isArray(req.body.items) ? req.body.items : [];
  if (!name || !phone) return res.status(400).json({ error: 'Add a name and a phone number.' });
  if (!cart.length) return res.status(400).json({ error: 'Your bag is empty.' });

  // Price server-side. Never trust a total the browser calculated.
  const ids = cart.slice(0, 30).map(l => parseInt(l.id)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Those pieces are no longer available.' });

  const rows = await q(
    'SELECT id, sku, title, price FROM products WHERE id = ANY(@ids) AND active = TRUE', { ids });
  const byId = new Map(rows.map(r => [r.id, r]));

  const items = [];
  let total = 0;
  for (const line of cart.slice(0, 30)) {
    const p = byId.get(parseInt(line.id));
    if (!p) continue;
    const qty = Math.max(1, Math.min(10, parseInt(line.qty) || 1));
    items.push({ id: p.id, sku: p.sku, title: p.title, price: p.price, qty });
    total += p.price * qty;
  }
  if (!items.length) return res.status(400).json({ error: 'Those pieces are no longer available.' });

  const ref = 'SW' + Date.now().toString(36).toUpperCase().slice(-6);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders (ref, name, phone, note, items, total)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [ref, name, phone, String(req.body.note || '').slice(0, 500), JSON.stringify(items), total]);
    for (const it of items) {
      await client.query(
        'UPDATE products SET order_count = order_count + $1 WHERE id = $2', [it.qty, it.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Build the message whole, then encode once — encoding in pieces double-escapes.
  const message = [
    `SeWeaves enquiry ${ref}`,
    ...items.map(i => `${i.qty} x ${i.title} (${i.sku})`),
    `Total Rs ${total.toLocaleString('en-IN')}`,
    `Name: ${name}`,
    `Phone: ${phone}`
  ].join('\n');

  res.json({
    ok: true, ref, total,
    whatsapp: `https://wa.me/${SHOP_WHATSAPP}?text=${encodeURIComponent(message)}`
  });
}));

/* ------------------------------- admin ----------------------------- */
function normalise(body) {
  const v = {};
  v.title = String(body.title || '').trim();
  v.sku = String(body.sku || '').trim().toUpperCase();
  v.collection = ['bridal', 'party', 'festive', 'designer', 'blouse']
    .includes(body.collection) ? body.collection : 'designer';
  for (const n of ['price', 'mrp', 'stock', 'boost']) v[n] = parseInt(body[n]) || 0;
  for (const s of ['fabric', 'colour', 'work', 'blouse_size', 'description'])
    v[s] = String(body[s] || '').trim();
  v.active = Boolean(body.active);
  v.images = JSON.stringify((Array.isArray(body.images) ? body.images : []).slice(0, 8));
  return v;
}

app.get('/api/admin/products', requireAdmin, wrap(async (req, res) => {
  res.json(await listProducts({
    q: String(req.query.q || ''), sort: String(req.query.sort || 'recommended'),
    includeInactive: true, limit: 200
  }));
}));

app.post('/api/admin/products', requireAdmin, wrap(async (req, res) => {
  const v = normalise(req.body);
  if (!v.title) return res.status(400).json({ error: 'Give the piece a title.' });
  if (!v.sku) return res.status(400).json({ error: 'Give the piece an SKU.' });
  if (v.price <= 0) return res.status(400).json({ error: 'Set a price above zero.' });
  if (await one('SELECT 1 FROM products WHERE sku = @sku', { sku: v.sku }))
    return res.status(400).json({ error: `SKU ${v.sku} is already in the catalogue.` });

  const row = await one(`
    INSERT INTO products (sku, slug, title, collection, fabric, colour, work, blouse_size,
                          description, price, mrp, stock, images, active, boost)
    VALUES (@sku,@slug,@title,@collection,@fabric,@colour,@work,@blouse_size,
            @description,@price,@mrp,@stock,@images::jsonb,@active,@boost)
    RETURNING id`, { ...v, slug: await uniqueSlug(v.title) });
  res.json({ ok: true, id: row.id });
}));

app.put('/api/admin/products/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const existing = await one('SELECT images FROM products WHERE id = @id', { id });
  if (!existing) return res.status(404).json({ error: 'No such piece.' });

  const v = normalise(req.body);
  if (!v.title) return res.status(400).json({ error: 'Give the piece a title.' });
  if (v.price <= 0) return res.status(400).json({ error: 'Set a price above zero.' });

  const clash = await one(
    'SELECT 1 FROM products WHERE sku = @sku AND id <> @id', { sku: v.sku, id });
  if (clash) return res.status(400).json({ error: `SKU ${v.sku} belongs to another piece.` });

  await q(`
    UPDATE products SET sku=@sku, title=@title, collection=@collection, fabric=@fabric,
      colour=@colour, work=@work, blouse_size=@blouse_size, description=@description,
      price=@price, mrp=@mrp, stock=@stock, images=@images::jsonb, active=@active, boost=@boost
    WHERE id=@id`, { ...v, id });

  // Photos dropped from the piece are dropped from storage too, or R2 fills up
  // with images nothing references.
  const kept = new Set(JSON.parse(v.images));
  for (const url of (existing.images || [])) {
    if (!kept.has(url)) {
      await storage.remove(url);
      await storage.remove(url.replace(/\.webp$/, '-thumb.webp'));
    }
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/products/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const row = await one('SELECT images FROM products WHERE id = @id', { id });
  await q('DELETE FROM products WHERE id = @id', { id });
  for (const url of (row?.images || [])) {
    await storage.remove(url);
    await storage.remove(url.replace(/\.webp$/, '-thumb.webp'));
  }
  res.json({ ok: true });
}));

app.get('/api/admin/orders', requireAdmin, wrap(async (_req, res) =>
  res.json(await q('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'))));

app.put('/api/admin/orders/:id', requireAdmin, wrap(async (req, res) => {
  const status = ['new', 'confirmed', 'shipped', 'closed'].includes(req.body.status)
    ? req.body.status : 'new';
  await q('UPDATE orders SET status = @status WHERE id = @id',
    { status, id: parseInt(req.params.id) });
  res.json({ ok: true });
}));

app.get('/api/admin/reviews', requireAdmin, wrap(async (_req, res) =>
  res.json(await q(`
    SELECT r.*, p.title, p.slug FROM reviews r
    JOIN products p ON p.id = r.product_id
    ORDER BY r.approved ASC, r.created_at DESC LIMIT 200`))));

app.post('/api/admin/reviews/:id/approve', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const r = await one('SELECT * FROM reviews WHERE id = @id', { id });
  if (!r) return res.status(404).json({ error: 'No such review.' });

  if (!r.approved) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE reviews SET approved = TRUE WHERE id = $1', [id]);
      await client.query(
        `UPDATE products SET rating_sum = rating_sum + $1, rating_count = rating_count + 1
         WHERE id = $2`, [r.rating, r.product_id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/reviews/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const r = await one('SELECT * FROM reviews WHERE id = @id', { id });
  if (r?.approved) {
    await q(`UPDATE products SET rating_sum = rating_sum - @rating,
             rating_count = rating_count - 1 WHERE id = @pid`,
      { rating: r.rating, pid: r.product_id });
  }
  await q('DELETE FROM reviews WHERE id = @id', { id });
  res.json({ ok: true });
}));

app.get('/api/admin/stats', requireAdmin, wrap(async (_req, res) => {
  const row = await one(`
    SELECT
      (SELECT COUNT(*)::INT FROM products)                              AS products,
      (SELECT COUNT(*)::INT FROM products WHERE active)                 AS live,
      (SELECT COUNT(*)::INT FROM products WHERE stock <= 0 AND active)  AS "outOfStock",
      (SELECT COUNT(*)::INT FROM orders WHERE status = 'new')           AS "newOrders",
      (SELECT COUNT(*)::INT FROM reviews WHERE NOT approved)            AS "pendingReviews"
  `);
  res.json(row);
}));

/* ------------------------------- static ---------------------------- */
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.get('/piece/:slug', (_req, res) =>
  res.sendFile(path.join(ROOT, 'public', 'product.html')));

// Render pings this to decide the service is up.
app.get('/healthz', wrap(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something broke at our end. Try again.' });
});

/* -------------------------------- boot ----------------------------- */
migrate()
  .then(() => {
    app.listen(PORT, () => {
      const index = path.join(ROOT, 'public', 'index.html');
      console.log(`SeWeaves running on :${PORT}`);
      console.log(`  root       ${ROOT}`);
      console.log(`  storefront ${fs.existsSync(index) ? 'found' : 'MISSING — public/ is not next to server.js'}`);
      console.log(`Images: ${storage.describeStorage()}`);
      if (!ADMIN_PASSWORD) console.warn('⚠  ADMIN_PASSWORD is unset — you cannot sign in.');
      if (SHOP_WHATSAPP.includes('X')) console.warn('⚠  SHOP_WHATSAPP is unset — orders will not reach you.');
    });
  })
  .catch(err => {
    console.error('Could not reach the database:', err.message);
    process.exit(1);
  });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { await pool.end().catch(() => {}); process.exit(0); });
}
