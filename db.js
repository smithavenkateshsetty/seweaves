/* Picks the storage engine at boot.
 *
 *   DATABASE_URL set    → Postgres (Neon, Supabase, anything). Persists.
 *   DATABASE_URL unset  → SQLite file on disk. Fine locally; on a host with an
 *                         ephemeral filesystem the catalogue resets on restart.
 *
 * Both modules expose the same functions, so nothing downstream cares which
 * one is in use. */
const usingPostgres = Boolean(process.env.DATABASE_URL);

const impl = usingPostgres
  ? await import('./db-postgres.js')
  : await import('./db-sqlite.js');

console.log(usingPostgres
  ? 'Database: Postgres — your catalogue survives restarts'
  : 'Database: SQLite file — set DATABASE_URL to make it persist');

export const pool = impl.pool;
export const q = impl.q;
export const one = impl.one;
export const migrate = impl.migrate;
export const listProducts = impl.listProducts;
export const getProduct = impl.getProduct;
export const facets = impl.facets;
export const slugify = impl.slugify;
export const uniqueSlug = impl.uniqueSlug;
export { usingPostgres };
