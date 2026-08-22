/* Regression guard.
 * The browser parses app.js and product.js into one shared global scope. A name
 * declared in both is a duplicate `const` — a SyntaxError at parse time, which
 * kills the whole file silently. This caught exactly that bug once already.
 * Run with: npm run check
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const combined = path.join(os.tmpdir(), 'seweaves_script_check.js');

const read = f => {
  if (!fs.existsSync(f)) {
    console.error(`FAIL — ${f} is missing. Browser files belong in public/.`);
    process.exit(1);
  }
  return fs.readFileSync(f, 'utf8');
};

fs.writeFileSync(combined,
  read(path.join('public', 'app.js')) + '\n' + read(path.join('public', 'product.js')));

try {
  execFileSync(process.execPath, ['--check', combined], { stdio: 'pipe' });
  console.log('PASS — app.js and product.js coexist in one scope');
} catch (err) {
  console.error('FAIL — the two scripts collide:\n');
  console.error((err.stderr || Buffer.from('')).toString().split('\n').slice(0, 5).join('\n'));
  process.exit(1);
} finally {
  try { fs.unlinkSync(combined); } catch { /* nothing to clean up */ }
}
