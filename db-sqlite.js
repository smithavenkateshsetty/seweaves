/* SQLite storage with the same async interface the app expects.
 * No DATABASE_URL, no external service — the shop runs the moment it boots. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const sqlite = new Database(path.join(DATA_DIR, 'seweaves.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// LOG() is not compiled into every SQLite build, and the ranking depends on it.
sqlite.function('LOG', n => Math.log(Number(n) || 0 + 1e-9) || 0);

/* ---------------------- SQL dialect translation --------------------- *
 * The handlers are written in Postgres flavour. Rather than edit every
 * call site, the few constructs actually used are rewritten here.
 * -------------------------------------------------------------------- */
function toSqlite(sql) {
  return sql
    .replace(/=\s*ANY\(@(\w+)\)/gi, 'IN (SELECT value FROM json_each(@$1))')
    .replace(/::jsonb|::INT\b|::int\b|::text/gi, '')
    .replace(/\bnow\(\)\s*\+\s*interval\s*'(\d+)\s*days?'/gi, "datetime('now','+$1 days')")
    .replace(/\bnow\(\)/gi, "datetime('now')")
    .replace(/\bWHERE NOT approved\b/gi, 'WHERE approved = 0')
    .replace(/\bWHERE active\b(?!\s*=)/gi, 'WHERE active = 1')
    .replace(/\bAND active\b(?!\s*=)/gi, 'AND active = 1')
    .replace(/\bTRUE\b/g, '1')
    .replace(/\bFALSE\b/g, '0');
}

// better-sqlite3 throws on unused parameters and on JS types it cannot bind.
function bindable(sql, params) {
  const named = new Set([...sql.matchAll(/@(\w+)/g)].map(m => m[1]));
  const out = {};
  for (const key of named) {
    let v = params[key];
    if (v === undefined) v = null;
    else if (typeof v === 'boolean') v = v ? 1 : 0;
    else if (Array.isArray(v) || (v && typeof v === 'object')) v = JSON.stringify(v);
    out[key] = v;
  }
  return out;
}

const JSON_COLUMNS = new Set(['images', 'items']);

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (JSON_COLUMNS.has(key) && typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch { out[key] = []; }
    }
  }
  if ('active' in out) out.active = Boolean(out.active);
  if ('approved' in out) out.approved = Boolean(out.approved);
  return out;
}

export async function q(text, params = {}) {
  const sql = toSqlite(text);
  const stmt = sqlite.prepare(sql);
  const args = bindable(sql, params);
  if (stmt.reader) return stmt.all(args).map(hydrate);
  stmt.run(args);
  return [];
}

export const one = async (text, params) => (await q(text, params))[0] || null;

/* A minimal stand-in for the pg pool, so transaction and health-check code
 * that expects .query / .connect / .end keeps working unchanged. */
function runPositional(text, values = []) {
  let i = 0;
  const sql = toSqlite(text).replace(/\$\d+/g, () => '?');
  const args = values.map(v =>
    typeof v === 'boolean' ? (v ? 1 : 0)
      : (Array.isArray(v) || (v && typeof v === 'object')) ? JSON.stringify(v) : v);
  const stmt = sqlite.prepare(sql);
  if (stmt.reader) return { rows: stmt.all(args).map(hydrate) };
  stmt.run(args);
  return { rows: [] };
}

export const pool = {
  async query(text, values) { return runPositional(text, values); },
  async connect() {
    return {
      async query(text, values) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) { sqlite.exec(text); return { rows: [] }; }
        return runPositional(text, values);
      },
      release() {}
    };
  },
  async end() { sqlite.close(); }
};

/* ------------------------------ schema ------------------------------ */
export async function migrate() {
  sqlite.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
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
    images       TEXT NOT NULL DEFAULT '[]',
    discount_type  TEXT NOT NULL DEFAULT 'none',
    discount_value INTEGER NOT NULL DEFAULT 0,
    active       INTEGER NOT NULL DEFAULT 1,
    boost        INTEGER NOT NULL DEFAULT 0,
    views        INTEGER NOT NULL DEFAULT 0,
    order_count  INTEGER NOT NULL DEFAULT 0,
    rating_sum   INTEGER NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_products_active     ON products(active);
  CREATE INDEX IF NOT EXISTS idx_products_collection ON products(collection, active);

  CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body       TEXT DEFAULT '',
    approved   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, approved);

  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ref        TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    note       TEXT DEFAULT '',
    items      TEXT NOT NULL,
    total      INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    expires_at TEXT NOT NULL
  );
  `);

  // Added after the first release — existing catalogues need the columns.
  const cols = sqlite.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!cols.includes('discount_type'))
    sqlite.exec("ALTER TABLE products ADD COLUMN discount_type TEXT NOT NULL DEFAULT 'none'");
  if (!cols.includes('discount_value'))
    sqlite.exec('ALTER TABLE products ADD COLUMN discount_value INTEGER NOT NULL DEFAULT 0');

  return true;
}

/* ----------------------------- ranking ------------------------------ */
const RANK = `
  (
    (p.boost * 100.0)
    + (15.0 * LOG(1 + p.order_count))
    + (1.5  * LOG(1 + p.views))
    + (8.0  * ((p.rating_sum + 20.0) / (p.rating_count + 5.0)))
    + (30.0 * MAX(0, 1 - (julianday('now') - julianday(p.created_at)) / 45.0))
    - (CASE WHEN p.stock <= 0 THEN 250 ELSE 0 END)
  )`;

const SORTS = {
  recommended: `${RANK} DESC, p.id DESC`,
  newest:      `p.created_at DESC, p.id DESC`,
  price_asc:   `p.price ASC, p.id DESC`,
  price_desc:  `p.price DESC, p.id DESC`,
  rating:      `(CAST(p.rating_sum AS REAL) / MAX(p.rating_count,1)) DESC, p.rating_count DESC`,
  popular:     `p.order_count DESC, p.views DESC`
};

export async function listProducts({
  collection = '', q: search = '', sort = 'recommended',
  minPrice = 0, maxPrice = 0, inStock = false,
  limit = 24, offset = 0, includeInactive = false
} = {}) {
  const where = [];
  const args = { limit, offset };

  if (!includeInactive) where.push('p.active = 1');
  if (collection) { where.push('p.collection = @collection'); args.collection = collection; }
  if (search) {
    where.push(`(p.title LIKE @search OR p.fabric LIKE @search OR p.colour LIKE @search
                 OR p.work LIKE @search OR p.sku LIKE @search OR p.description LIKE @search)`);
    args.search = `%${search}%`;
  }
  if (minPrice > 0) { where.push('p.price >= @minPrice'); args.minPrice = minPrice; }
  if (maxPrice > 0) { where.push('p.price <= @maxPrice'); args.maxPrice = maxPrice; }
  if (inStock) where.push('p.stock > 0');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = SORTS[sort] || SORTS.recommended;

  const items = await q(`
    SELECT p.*, ${RANK} AS rank_score,
           ROUND(CAST(p.rating_sum AS REAL) / MAX(p.rating_count,1), 1) AS avg_rating
    FROM products p ${clause}
    ORDER BY ${order} LIMIT @limit OFFSET @offset`, args);

  const count = await one(`SELECT COUNT(*) AS total FROM products p ${clause}`, args);
  return { total: count?.total || 0, items };
}

export async function getProduct(slug, { includeInactive = false } = {}) {
  const product = await one(`
    SELECT p.*, ROUND(CAST(p.rating_sum AS REAL) / MAX(p.rating_count,1), 1) AS avg_rating
    FROM products p
    WHERE p.slug = @slug ${includeInactive ? '' : 'AND p.active = 1'}`, { slug });
  if (!product) return null;
  product.reviews = await q(`
    SELECT name, rating, body, created_at FROM reviews
    WHERE product_id = @id AND approved = 1
    ORDER BY created_at DESC LIMIT 30`, { id: product.id });
  return product;
}

export async function facets() {
  return {
    collections: await q(`SELECT collection, COUNT(*) AS n FROM products
                          WHERE active = 1 GROUP BY collection ORDER BY n DESC`),
    fabrics: await q(`SELECT fabric, COUNT(*) AS n FROM products
                      WHERE active = 1 AND fabric <> '' GROUP BY fabric ORDER BY n DESC LIMIT 12`),
    price: await one(`SELECT MIN(price) AS min, MAX(price) AS max FROM products WHERE active = 1`)
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

export { DATA_DIR };
