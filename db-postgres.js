/* Postgres storage — used whenever DATABASE_URL is set (Neon, Supabase, RDS).
 * Exposes the same interface as db-sqlite.js so nothing else changes. */
import pg from 'pg';

const { Pool } = pg;

// Neon requires TLS. Its chain is not in Node's default store on every host,
// so verification is relaxed while the transport itself stays encrypted.
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.PG_POOL_MAX) || 5,  // Neon's free tier caps connections
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000               // a sleeping Neon branch takes a moment
});

pool.on('error', err => console.error('Postgres pool error:', err.message));

/* The handlers use @named parameters; pg wants $1, $2. Translate, preserving
 * order and reusing the same index when a name repeats. */
function toPositional(text, params = {}) {
  const values = [];
  const seen = new Map();
  const sql = text.replace(/@(\w+)/g, (_m, name) => {
    if (!seen.has(name)) {
      values.push(params[name] === undefined ? null : params[name]);
      seen.set(name, values.length);
    }
    return `$${seen.get(name)}`;
  });
  return { sql, values };
}

export async function q(text, params = {}) {
  const { sql, values } = toPositional(text, params);
  const res = await pool.query(sql, values);
  return res.rows;
}

export const one = async (text, params) => (await q(text, params))[0] || null;

/* ------------------------------ schema ------------------------------ */
export async function migrate() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS products (
    id           SERIAL PRIMARY KEY,
    sku          TEXT UNIQUE NOT NULL,
    slug         TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    collection   TEXT NOT NULL,
    fabric       TEXT DEFAULT '',
    colour       TEXT DEFAULT '',
    work         TEXT DEFAULT '',
    blouse_size  TEXT DEFAULT '',
    description  TEXT DEFAULT '',
    price        INTEGER NOT NULL,
    mrp          INTEGER DEFAULT 0,
    stock        INTEGER NOT NULL DEFAULT 1,
    images       JSONB NOT NULL DEFAULT '[]'::jsonb,
    discount_type  TEXT NOT NULL DEFAULT 'none',
    discount_value INTEGER NOT NULL DEFAULT 0,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    boost        INTEGER NOT NULL DEFAULT 0,
    views        INTEGER NOT NULL DEFAULT 0,
    order_count  INTEGER NOT NULL DEFAULT 0,
    rating_sum   INTEGER NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_products_active     ON products(active);
  CREATE INDEX IF NOT EXISTS idx_products_collection ON products(collection, active);

  CREATE TABLE IF NOT EXISTS reviews (
    id         SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body       TEXT DEFAULT '',
    approved   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, approved);

  CREATE TABLE IF NOT EXISTS orders (
    id         SERIAL PRIMARY KEY,
    ref        TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    note       TEXT DEFAULT '',
    items      JSONB NOT NULL,
    total      INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS site_hits (
    day   TEXT NOT NULL,
    kind  TEXT NOT NULL,
    hits  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, kind)
  );

  CREATE TABLE IF NOT EXISTS site_visitors (
    day     TEXT NOT NULL,
    visitor TEXT NOT NULL,
    PRIMARY KEY (day, visitor)
  );

  CREATE TABLE IF NOT EXISTS site_refs (
    day  TEXT NOT NULL,
    ref  TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, ref)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `);

  // Added after the first release — live catalogues need the columns.
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_type  TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_value INTEGER NOT NULL DEFAULT 0;
  `);

  return true;
}

/* ----------------------------- ranking ------------------------------ *
 * ln() not log() — Postgres log() is base 10, which would flatten the
 * damping the sales signal depends on.
 * -------------------------------------------------------------------- */
const RANK = `
  (
    (p.boost * 100.0)
    + (15.0 * ln(1 + p.order_count))
    + (1.5  * ln(1 + p.views))
    + (8.0  * ((p.rating_sum + 20.0) / (p.rating_count + 5.0)))
    + (30.0 * GREATEST(0, 1 - EXTRACT(EPOCH FROM (now() - p.created_at)) / 86400.0 / 45.0))
    - (CASE WHEN p.stock <= 0 THEN 250 ELSE 0 END)
  )`;

const SORTS = {
  recommended: `${RANK} DESC, p.id DESC`,
  newest:      `p.created_at DESC, p.id DESC`,
  price_asc:   `p.price ASC, p.id DESC`,
  price_desc:  `p.price DESC, p.id DESC`,
  rating:      `(p.rating_sum::NUMERIC / GREATEST(p.rating_count,1)) DESC, p.rating_count DESC`,
  popular:     `p.order_count DESC, p.views DESC`
};

export async function listProducts({
  collection = '', q: search = '', sort = 'recommended',
  minPrice = 0, maxPrice = 0, inStock = false,
  limit = 24, offset = 0, includeInactive = false
} = {}) {
  const where = [];
  const args = { limit, offset };

  if (!includeInactive) where.push('p.active = TRUE');
  if (collection) { where.push('p.collection = @collection'); args.collection = collection; }
  if (search) {
    where.push(`(p.title ILIKE @search OR p.fabric ILIKE @search OR p.colour ILIKE @search
                 OR p.work ILIKE @search OR p.sku ILIKE @search OR p.description ILIKE @search)`);
    args.search = `%${search}%`;
  }
  if (minPrice > 0) { where.push('p.price >= @minPrice'); args.minPrice = minPrice; }
  if (maxPrice > 0) { where.push('p.price <= @maxPrice'); args.maxPrice = maxPrice; }
  if (inStock) where.push('p.stock > 0');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = SORTS[sort] || SORTS.recommended;

  const items = await q(`
    SELECT p.*, ${RANK} AS rank_score,
           ROUND(p.rating_sum::NUMERIC / GREATEST(p.rating_count,1), 1)::FLOAT AS avg_rating
    FROM products p ${clause}
    ORDER BY ${order} LIMIT @limit OFFSET @offset`, args);

  const count = await one(`SELECT COUNT(*)::INT AS total FROM products p ${clause}`, args);
  return { total: count?.total || 0, items: items.map(numbers) };
}

export async function getProduct(slug, { includeInactive = false } = {}) {
  const product = await one(`
    SELECT p.*, ROUND(p.rating_sum::NUMERIC / GREATEST(p.rating_count,1), 1)::FLOAT AS avg_rating
    FROM products p
    WHERE p.slug = @slug ${includeInactive ? '' : 'AND p.active = TRUE'}`, { slug });
  if (!product) return null;
  product.reviews = await q(`
    SELECT name, rating, body, created_at FROM reviews
    WHERE product_id = @id AND approved = TRUE
    ORDER BY created_at DESC LIMIT 30`, { id: product.id });
  return numbers(product);
}

// rank_score arrives as a string for NUMERIC types; the client does maths on it.
function numbers(row) {
  if (row && row.rank_score !== undefined) row.rank_score = Number(row.rank_score);
  if (row && row.avg_rating !== undefined) row.avg_rating = Number(row.avg_rating);
  return row;
}

export async function facets() {
  return {
    collections: await q(`SELECT collection, COUNT(*)::INT AS n FROM products
                          WHERE active = TRUE GROUP BY collection ORDER BY n DESC`),
    fabrics: await q(`SELECT fabric, COUNT(*)::INT AS n FROM products
                      WHERE active = TRUE AND fabric <> '' GROUP BY fabric
                      ORDER BY n DESC LIMIT 12`),
    price: await one(`SELECT MIN(price) AS min, MAX(price) AS max FROM products
                      WHERE active = TRUE`)
  };
}

export function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').slice(0, 70) || 'piece';
}

export async function uniqueSlug(base) {
  const root = slugify(base);
  let slug = root, n = 1;
  while (await one('SELECT 1 FROM products WHERE slug = @slug', { slug })) slug = `${root}-${++n}`;
  return slug;
}
