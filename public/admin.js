const $ = id => document.getElementById(id);
const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thumb = s => s ? s.replace(/\.webp$/, '-thumb.webp') : '';
const LABEL = { bridal: 'Bridal', party: 'Party', festive: 'Festive', designer: 'Designer', blouse: 'Blouse' };

let shots = [];        // image paths on the current form
let editingId = null;

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {}, ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error('Signed out.'); }
  if (!res.ok) throw new Error(data.error || 'That did not work.');
  return data;
}

/* ------------------------------ auth ------------------------------- */
function showLogin() { $('loginView').hidden = false; $('appView').hidden = true; $('signOut').hidden = true; }
function showApp() { $('loginView').hidden = true; $('appView').hidden = false; $('signOut').hidden = false; refreshAll(); }

$('signIn').onclick = async () => {
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) });
    $('pw').value = ''; $('loginMsg').innerHTML = ''; showApp();
  } catch (e) { $('loginMsg').innerHTML = `<p class="note bad">${esc(e.message)}</p>`; }
};
$('pw').onkeydown = e => { if (e.key === 'Enter') $('signIn').click(); };
$('signOut').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); showLogin(); };

/* ------------------------------ tabs ------------------------------- */
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x =>
    x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('[data-panel]').forEach(p =>
    p.hidden = p.dataset.panel !== b.dataset.tab);
});
function goTab(name) { document.querySelector(`.tabs button[data-tab="${name}"]`).click(); }

/* ---------------------------- catalogue ---------------------------- */
/* ------------------------ inline editing ---------------------------- *
 * Every cell in the catalogue table is editable. Changes are held locally
 * and written in one batch, so adjusting twenty prices is one request and
 * one undo, not twenty of each.
 * -------------------------------------------------------------------- */
const dirty = new Map();          // id -> { field: value }
let rows = [];                    // last loaded rows, for previewing prices
let storeDiscountPct = 0;

function markDirty(id, field, value) {
  const original = rows.find(r => r.id === id);
  const changes = dirty.get(id) || {};

  // Reverting a cell by hand should clear it, not queue a no-op write.
  if (original && String(original[field] ?? '') === String(value)) delete changes[field];
  else changes[field] = value;

  if (Object.keys(changes).length) dirty.set(id, changes);
  else dirty.delete(id);

  const tr = document.querySelector(`tr[data-row="${id}"]`);
  if (tr) tr.classList.toggle('dirty', dirty.has(id));
  paintPreview(id);
  paintSaveBar();
}

function currentValue(p, field) {
  const changes = dirty.get(p.id);
  return changes && field in changes ? changes[field] : p[field];
}

// Recompute the customer-facing price as you type, using the same rules
// the server applies on save.
function paintPreview(id) {
  const p = rows.find(r => r.id === id);
  const cell = document.querySelector(`[data-preview="${id}"]`);
  if (!p || !cell) return;

  const price = parseInt(currentValue(p, 'price')) || 0;
  const type = currentValue(p, 'discount_type') || 'none';
  const value = parseInt(currentValue(p, 'discount_value')) || 0;

  let final = price, source = 'none';
  if (type === 'percent' && value > 0) { final = Math.round(price * (1 - Math.min(90, value) / 100)); source = 'piece'; }
  else if (type === 'amount' && value > 0) { final = Math.max(Math.round(price * 0.1), price - value); source = 'piece'; }
  else if (storeDiscountPct > 0) { final = Math.round(price * (1 - storeDiscountPct / 100)); source = 'store'; }

  const pct = price > 0 && final < price ? Math.round((1 - final / price) * 100) : 0;
  cell.innerHTML = pct > 0
    ? `<span class="final">${rupees(final)}</span><span class="was">${rupees(price)}</span>
       <span class="offpill">${pct}% ${source}</span>`
    : `<span class="final">${rupees(price)}</span>`;
}

function paintSaveBar() {
  const bar = $('saveBar');
  if (!bar) return;
  const n = dirty.size;
  bar.classList.toggle('show', n > 0);
  const label = $('dirtyCount');
  if (label) label.textContent = `${n} piece${n === 1 ? '' : 's'} changed`;
}

async function loadProducts() {
  const term = $('pSearch').value.trim();
  const data = await api('/api/admin/products?q=' + encodeURIComponent(term));
  rows = data.items;
  storeDiscountPct = data.store_discount || 0;
  dirty.clear();
  paintSaveBar();
  $('pCount').textContent = `${data.total} piece${data.total === 1 ? '' : 's'}`;

  if (!rows.length) {
    $('pRows').innerHTML = `<tr><td colspan="10" class="empty">
      Nothing in the catalogue yet. Add your first piece.</td></tr>`;
    return;
  }

  $('pRows').innerHTML = rows.map(p => `<tr data-row="${p.id}">
    <td>${p.images[0] ? `<img src="${thumb(p.images[0])}" alt="">` : ''}</td>
    <td>
      <input class="cell wide" value="${esc(p.title)}" data-f="title" data-id="${p.id}">
      <span class="muted" style="font-size:.76rem">${esc(p.sku)} · ${LABEL[p.collection] || p.collection}</span>
    </td>
    <td><input class="cell num" type="number" min="1" value="${p.price}" data-f="price" data-id="${p.id}"></td>
    <td>
      <select class="cell" data-f="discount_type" data-id="${p.id}">
        <option value="none"    ${p.discount_type === 'none' || !p.discount_type ? 'selected' : ''}>Store</option>
        <option value="percent" ${p.discount_type === 'percent' ? 'selected' : ''}>% off</option>
        <option value="amount"  ${p.discount_type === 'amount' ? 'selected' : ''}>₹ off</option>
      </select>
      <input class="cell num" type="number" min="0" value="${p.discount_value || 0}"
             data-f="discount_value" data-id="${p.id}">
    </td>
    <td data-preview="${p.id}"></td>
    <td><input class="cell num" type="number" min="0" value="${p.stock}" data-f="stock" data-id="${p.id}"></td>
    <td><input class="cell num" type="number" min="0" max="10" value="${p.boost}" data-f="boost" data-id="${p.id}"></td>
    <td class="muted">${Math.round(p.rank_score)}</td>
    <td><label class="livebox"><input type="checkbox" ${p.active ? 'checked' : ''}
        data-f="active" data-id="${p.id}"><span></span></label></td>
    <td style="white-space:nowrap">
      <button class="btn ghost sm" data-edit="${p.id}">Photos</button>
      <button class="btn ghost sm" data-del="${p.id}">Delete</button></td>
  </tr>`).join('');

  rows.forEach(p => paintPreview(p.id));

  $('pRows').querySelectorAll('[data-f]').forEach(el => {
    const handler = () => markDirty(+el.dataset.id, el.dataset.f,
      el.type === 'checkbox' ? el.checked : el.value);
    el.oninput = handler;
    el.onchange = handler;
    // Enter saves everything; Escape abandons the batch.
    el.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); saveAll(); }
      if (e.key === 'Escape') { e.preventDefault(); loadProducts(); }
    };
  });

  $('pRows').querySelectorAll('[data-edit]').forEach(b => b.onclick = () =>
    startEdit(rows.find(x => x.id === +b.dataset.edit)));

  $('pRows').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const p = rows.find(x => x.id === +b.dataset.del);
    if (!confirm(`Delete "${p.title}"? This cannot be undone.`)) return;
    await api(`/api/admin/products/${p.id}`, { method: 'DELETE' });
    refreshAll();
  });
}

async function saveAll() {
  if (!dirty.size) return;
  const btn = $('saveAll'), msg = $('saveBarMsg');
  const updates = [...dirty.entries()].map(([id, changes]) => ({ id, ...changes }));

  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await api('/api/admin/products/bulk', {
      method: 'PATCH', body: JSON.stringify({ updates })
    });
    msg.innerHTML = '';
    await loadProducts();
    await loadStats();
    $('discountMsg').innerHTML =
      `<p class="note good">Saved ${res.updated} piece${res.updated === 1 ? '' : 's'}.</p>`;
    setTimeout(() => { $('discountMsg').innerHTML = ''; }, 4000);
  } catch (e) {
    // Nothing was written — the server validates the whole batch first.
    msg.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save all changes';
  }
}

const saveAllBtn = $('saveAll');
if (saveAllBtn) saveAllBtn.onclick = saveAll;
const discardBtn = $('discardAll');
if (discardBtn) discardBtn.onclick = () => loadProducts();

// Losing twenty edits to a stray click would be miserable.
window.addEventListener('beforeunload', e => {
  if (dirty.size) { e.preventDefault(); e.returnValue = ''; }
});

$('pSearch').oninput = (() => {
  let t; return () => { clearTimeout(t); t = setTimeout(loadProducts, 300); };
})();

/* ------------------------------ form ------------------------------- */
const F = {
  title: 'fTitle', sku: 'fSku', collection: 'fCollection', price: 'fPrice', mrp: 'fMrp',
  fabric: 'fFabric', colour: 'fColour', work: 'fWork', blouse_size: 'fSize',
  stock: 'fStock', boost: 'fBoost', description: 'fDesc',
  discount_type: 'fDiscType', discount_value: 'fDiscValue'
};

function readForm() {
  const v = {};
  for (const [k, id] of Object.entries(F)) v[k] = $(id).value;
  v.active = $('fActive').checked;
  v.images = shots;
  return v;
}
function fillForm(p) {
  for (const [k, id] of Object.entries(F)) {
    const fallback = k === 'stock' ? 1 : k === 'discount_type' ? 'none' : k === 'discount_value' ? 0 : '';
    $(id).value = p?.[k] ?? fallback;
  }
  hint();
  $('fActive').checked = p ? !!p.active : true;
  shots = p ? [...p.images] : [];
  paintShots();
}
function startEdit(p) {
  editingId = p.id;
  fillForm(p);
  $('formTitle').textContent = `Edit — ${p.title}`;
  $('cancelEdit').hidden = false;
  $('save').textContent = 'Save changes';
  goTab('add');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('cancelEdit').onclick = () => resetForm();
function resetForm() {
  editingId = null;
  fillForm(null);
  $('fMrp').value = 0; $('fBoost').value = 0; $('fStock').value = 1;
  $('fDiscType').value = 'none'; $('fDiscValue').value = 0; hint();
  $('formTitle').textContent = 'Add a piece';
  $('cancelEdit').hidden = true;
  $('save').textContent = 'Save the piece';
  $('saveMsg').innerHTML = '';
}

$('save').onclick = async () => {
  const btn = $('save'), msg = $('saveMsg');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const body = JSON.stringify(readForm());
    if (editingId) await api('/api/admin/products/' + editingId, { method: 'PUT', body });
    else await api('/api/admin/products', { method: 'POST', body });
    msg.innerHTML = `<p class="note good">Saved. It's on the rail now.</p>`;
    resetForm();
    refreshAll();
  } catch (e) {
    msg.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = editingId ? 'Save changes' : 'Save the piece';
  }
};

/* --------------------------- discounts ------------------------------ */
function hint() {
  const type = $('fDiscType')?.value;
  const value = parseInt($('fDiscValue')?.value) || 0;
  const price = parseInt($('fPrice')?.value) || 0;
  const el = $('discHint');
  if (!el) return;

  if (type === 'none' || value <= 0) {
    el.textContent = 'This piece follows the store-wide discount.';
    return;
  }
  const final = type === 'percent'
    ? Math.round(price * (1 - Math.min(90, value) / 100))
    : Math.max(1, price - value);
  const pct = price > 0 ? Math.round((1 - final / price) * 100) : 0;
  el.textContent = price > 0
    ? `Customer pays ${rupees(final)} — ${pct}% off ${rupees(price)}.`
    : 'Set a price first.';
}

['fDiscType', 'fDiscValue', 'fPrice'].forEach(id => {
  const el = $(id);
  if (el) el.oninput = el.onchange = hint;
});

async function loadDiscount() {
  const { store_discount } = await api('/api/admin/settings');
  $('storeDiscount').value = store_discount;
}

$('saveDiscount').onclick = async () => {
  const btn = $('saveDiscount'), msg = $('discountMsg');
  btn.disabled = true;
  try {
    const { store_discount } = await api('/api/admin/settings', {
      method: 'PUT', body: JSON.stringify({ store_discount: $('storeDiscount').value })
    });
    msg.innerHTML = store_discount > 0
      ? `<p class="note good">Every piece without its own discount is now ${store_discount}% off.</p>`
      : '<p class="note">Store-wide discount is off. Pieces with their own discount keep it.</p>';
    loadProducts();
  } catch (e) {
    msg.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
  } finally { btn.disabled = false; }
};

/* ----------------------------- uploads -----------------------------
 * Order matters: shots[0] is the cover — it's what shows on the shop grid
 * and in the customer's bag. Reorder by dragging, or with the arrows on touch.
 */
function paintShots() {
  const box = $('shots');
  if (!shots.length) { box.innerHTML = ''; return; }

  box.innerHTML = shots.map((s, i) => `<figure draggable="true" data-i="${i}">
    <img src="${thumb(s)}" alt="">
    ${i === 0 ? '<figcaption class="cover">Cover</figcaption>' : ''}
    <button class="rm" data-rm="${i}" aria-label="Remove photo ${i + 1}">&times;</button>
    <div class="nudge">
      <button data-left="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move photo earlier">&#8249;</button>
      <button data-right="${i}" ${i === shots.length - 1 ? 'disabled' : ''} aria-label="Move photo later">&#8250;</button>
    </div>
  </figure>`).join('') +
  `<p class="muted" style="width:100%;font-size:.82rem;margin:8px 0 0">
     ${shots.length} of 8 photos. The first one is the cover — drag to reorder.</p>`;

  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    shots.splice(+b.dataset.rm, 1); paintShots();
  });
  box.querySelectorAll('[data-left]').forEach(b => b.onclick = () => move(+b.dataset.left, -1));
  box.querySelectorAll('[data-right]').forEach(b => b.onclick = () => move(+b.dataset.right, 1));

  let from = null;
  box.querySelectorAll('figure').forEach(fig => {
    fig.ondragstart = e => { from = +fig.dataset.i; e.dataTransfer.effectAllowed = 'move'; fig.style.opacity = '.4'; };
    fig.ondragend = () => { fig.style.opacity = ''; };
    fig.ondragover = e => { e.preventDefault(); fig.style.outline = '2px solid var(--gold)'; };
    fig.ondragleave = () => { fig.style.outline = ''; };
    fig.ondrop = e => {
      e.preventDefault(); fig.style.outline = '';
      const to = +fig.dataset.i;
      if (from === null || from === to) return;
      shots.splice(to, 0, shots.splice(from, 1)[0]);
      from = null; paintShots();
    };
  });
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= shots.length) return;
  [shots[i], shots[j]] = [shots[j], shots[i]];
  paintShots();
}

const DROP_LABEL = 'Tap to choose photos, or drop them here — up to 8';

async function sendFiles(files) {
  if (!files.length) return;
  const room = 8 - shots.length;
  if (room <= 0) { $('drop').textContent = 'Eight photos is the limit. Remove one first.'; return; }

  const batch = [...files].slice(0, room);
  const skipped = files.length - batch.length;
  const fd = new FormData();
  batch.forEach(f => fd.append('images', f));
  $('drop').textContent = `Uploading ${batch.length} photo${batch.length === 1 ? '' : 's'}…`;

  try {
    const res = await fetch('/api/admin/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    shots = shots.concat(data.images).slice(0, 8);
    paintShots();
    $('drop').textContent = skipped > 0
      ? `Added ${batch.length}. ${skipped} skipped — eight is the limit.`
      : DROP_LABEL;
  } catch (e) {
    $('drop').textContent = e.message || 'Upload failed. Try a smaller image.';
  } finally {
    $('file').value = '';   // so re-picking the same file fires change again
  }
}

$('drop').onclick = () => $('file').click();
$('file').onchange = e => sendFiles(e.target.files);
$('drop').ondragover = e => { e.preventDefault(); $('drop').style.background = 'rgba(201,162,87,.12)'; };
$('drop').ondragleave = () => { $('drop').style.background = ''; };
$('drop').ondrop = e => { e.preventDefault(); $('drop').style.background = ''; sendFiles(e.dataTransfer.files); };

/* ----------------------------- orders ------------------------------ */
async function loadOrders() {
  const rows = await api('/api/admin/orders');
  if (!rows.length) {
    $('oRows').innerHTML = `<tr><td colspan="6" class="empty">No enquiries yet.</td></tr>`;
    return;
  }
  $('oRows').innerHTML = rows.map(o => `<tr>
    <td><b>${esc(o.ref)}</b></td>
    <td>${esc(o.name)}<br><a href="https://wa.me/${esc(o.phone.replace(/\D/g, ''))}"
        style="font-size:.82rem">${esc(o.phone)}</a>
      ${o.note ? `<br><span class="muted" style="font-size:.8rem">${esc(o.note)}</span>` : ''}</td>
    <td style="font-size:.85rem">${o.items.map(i => `${i.qty} × ${esc(i.title)}`).join('<br>')}</td>
    <td>${rupees(o.total)}</td>
    <td class="muted" style="font-size:.82rem">${new Date(o.created_at + 'Z').toLocaleDateString('en-IN')}</td>
    <td><select class="field" style="padding:5px 8px" data-status="${o.id}">
      ${['new', 'confirmed', 'shipped', 'closed'].map(s =>
        `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select></td>
  </tr>`).join('');

  $('oRows').querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
    await api(`/api/admin/orders/${sel.dataset.status}`, {
      method: 'PUT', body: JSON.stringify({ status: sel.value })
    });
    loadStats();
  });
}

/* ----------------------------- reviews ----------------------------- */
async function loadReviews() {
  const rows = await api('/api/admin/reviews');
  if (!rows.length) {
    $('rRows').innerHTML = `<tr><td colspan="6" class="empty">No reviews yet.</td></tr>`;
    return;
  }
  $('rRows').innerHTML = rows.map(r => `<tr>
    <td><a href="/piece/${esc(r.slug)}">${esc(r.title)}</a></td>
    <td>${esc(r.name)}</td>
    <td class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</td>
    <td style="font-size:.86rem;max-width:280px">${esc(r.body)}</td>
    <td><span class="pill ${r.approved ? '' : 'off'}">${r.approved ? 'Live' : 'Held'}</span></td>
    <td style="white-space:nowrap">
      ${r.approved ? '' : `<button class="btn ghost sm" data-ok="${r.id}">Approve</button>`}
      <button class="btn ghost sm" data-rdel="${r.id}">Delete</button></td>
  </tr>`).join('');

  $('rRows').querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => {
    await api(`/api/admin/reviews/${b.dataset.ok}/approve`, { method: 'POST' });
    refreshAll();
  });
  $('rRows').querySelectorAll('[data-rdel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this review?')) return;
    await api(`/api/admin/reviews/${b.dataset.rdel}`, { method: 'DELETE' });
    refreshAll();
  });
}

/* ------------------------------ stats ------------------------------ */
async function loadStats() {
  const s = await api('/api/admin/stats');
  $('stats').innerHTML = [
    ['Pieces', s.products], ['Live', s.live], ['Sold out', s.outOfStock],
    ['New enquiries', s.newOrders], ['Reviews held', s.pendingReviews]
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
}

async function refreshAll() {
  try { await Promise.all([loadStats(), loadProducts(), loadOrders(), loadReviews(), loadDiscount()]); }
  catch { /* api() already handled a signed-out state */ }
}

/* ------------------------------ boot ------------------------------- */
(async () => {
  const { signedIn } = await (await fetch('/api/admin/me')).json();
  signedIn ? showApp() : showLogin();
})();
