/* SeWeaves storefront ------------------------------------------------ */

const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const COLLECTION_LABEL = {
  bridal: 'Bridal specials', party: 'Party wear', festive: 'Festive collection',
  designer: 'Designer wear', blouse: 'Embroidery blouses'
};
const thumb = src => src ? src.replace(/\.webp$/, '-thumb.webp') : '';

/* ---------------------------- cart --------------------------------- */
// sessionStorage would be lost on the free tier's cold starts anyway, and the
// bag must survive a page navigation, so it lives in localStorage.
const Cart = {
  read() { try { return JSON.parse(localStorage.getItem('sw_bag') || '[]'); } catch { return []; } },
  write(items) { localStorage.setItem('sw_bag', JSON.stringify(items)); paintBag(); },
  add(p) {
    const items = Cart.read();
    const line = items.find(i => i.id === p.id);
    if (line) line.qty = Math.min(10, line.qty + 1);
    else items.push({ id: p.id, title: p.title, sku: p.sku, price: p.price, image: p.images?.[0] || '', qty: 1 });
    Cart.write(items);
  },
  setQty(id, qty) {
    const items = Cart.read().map(i => i.id === id ? { ...i, qty } : i).filter(i => i.qty > 0);
    Cart.write(items);
  },
  total() { return Cart.read().reduce((s, i) => s + i.price * i.qty, 0); },
  count() { return Cart.read().reduce((s, i) => s + i.qty, 0); }
};

/* Published before any DOM wiring. product.js destructures this on its first
 * line, so if a wiring error killed the script the whole page would hang. */

/* --------------------------- catalogue ----------------------------- */
const state = { q: '', collection: '', sort: 'recommended', min: 0, max: 0, inStock: false, page: 1 };
let loaded = [];

const $ = id => document.getElementById(id);
const grid = $('grid');

function skeletons(n = 8) {
  grid.innerHTML = Array.from({ length: n },
    () => '<div class="skeleton"><div class="shot"></div></div>').join('');
}

function tile(p) {
  // Second photo layered underneath and revealed on hover — for a saree the
  // pallu or the border is usually the shot that actually sells it.
  const shot = p.images[0]
    ? `<img src="${thumb(p.images[0])}" alt="${esc(p.title)}" loading="lazy" width="500" height="667">
       ${p.images[1] ? `<img class="alt" src="${thumb(p.images[1])}" alt="" loading="lazy">` : ''}
       ${p.images.length > 1 ? `<span class="shotcount">${p.images.length} photos</span>` : ''}`
    : `<div class="noshot">Photo coming</div>`;
  const flag = p.stock <= 0
    ? '<span class="flag out">Sold — ask us</span>'
    : (p.boost > 0 ? '<span class="flag">Featured</span>' : '');
  const stars = p.rating_count > 0
    ? `<p class="stars">${'★'.repeat(Math.round(p.avg_rating))}${'☆'.repeat(5 - Math.round(p.avg_rating))}
       <small>${p.rating_count}</small></p>` : '';
  const mrp = p.mrp > p.price ? `<del>${rupees(p.mrp)}</del>` : '';

  return `<a class="tile" href="/piece/${p.slug}">
    <div class="shot">${shot}${flag}</div>
    <div class="meta">
      <p class="sub">${esc(COLLECTION_LABEL[p.collection] || p.collection)}</p>
      <h3>${esc(p.title)}</h3>
      ${stars}
      <p class="price">${rupees(p.price)}${mrp}</p>
    </div>
  </a>`;
}

async function load(append = false) {
  if (!append) { skeletons(); state.page = 1; }
  const params = new URLSearchParams({
    q: state.q, collection: state.collection, sort: state.sort,
    min: state.min, max: state.max, page: state.page, limit: 12
  });
  if (state.inStock) params.set('inStock', '1');

  try {
    const res = await fetch('/api/products?' + params);
    const data = await res.json();
    loaded = append ? loaded.concat(data.items) : data.items;

    if (!loaded.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <p class="h2">Nothing matches that yet.</p>
        <p class="muted">Widen the price range, or clear the filters to see the full rail.</p></div>`;
      $('count').textContent = 'No pieces';
      $('more').hidden = true;
      return;
    }
    grid.innerHTML = loaded.map(tile).join('');
    $('count').textContent = `${data.total} piece${data.total === 1 ? '' : 's'}`;
    $('more').hidden = loaded.length >= data.total;
  } catch {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <p class="note bad">The catalogue didn't load. Check your connection and try again.</p></div>`;
  }
}

async function loadFacets() {
  try {
    const f = await (await fetch('/api/facets')).json();
    const box = $('collectionOpts');
    const all = f.collections.reduce((s, c) => s + c.n, 0);
    const rows = [{ collection: '', n: all }, ...f.collections];
    box.innerHTML = rows.map(c =>
      `<button class="fopt" data-c="${c.collection}" aria-pressed="${state.collection === c.collection}">
         ${esc(c.collection ? (COLLECTION_LABEL[c.collection] || c.collection) : 'Everything')}
         <span>${c.n}</span></button>`).join('');
    box.querySelectorAll('.fopt').forEach(b => b.onclick = () => {
      state.collection = b.dataset.c;
      box.querySelectorAll('.fopt').forEach(x =>
        x.setAttribute('aria-pressed', x.dataset.c === state.collection));
      load();
    });
  } catch { /* filters are an enhancement; the grid still works */ }
}

/* ----------------------------- bag UI ------------------------------ */
function paintBag() {
  const badge = $('bagCount');
  if (badge) badge.textContent = Cart.count();
  const items = Cart.read();
  const body = $('bagBody'), foot = $('bagFoot');
  if (!body || !foot) return;

  if (!items.length) {
    body.innerHTML = `<div class="empty">
      <p>Your bag is empty.</p>
      <p class="muted">Add a piece and we'll hold it while you decide.</p></div>`;
    foot.innerHTML = `<a class="btn ghost wide" href="/#catalogue">Browse the rail</a>`;
    return;
  }

  body.innerHTML = items.map(i => `<div class="line">
    ${i.image ? `<img src="${thumb(i.image)}" alt="">` : '<div></div>'}
    <div>
      <h4>${esc(i.title)}</h4>
      <p class="muted" style="font-size:.8rem;margin:0">${esc(i.sku)}</p>
      <div class="qty">
        <button data-dec="${i.id}" aria-label="Reduce quantity">−</button>
        <span>${i.qty}</span>
        <button data-inc="${i.id}" aria-label="Increase quantity">+</button>
      </div>
    </div>
    <span class="price">${rupees(i.price * i.qty)}</span>
  </div>`).join('');

  body.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => {
    const l = Cart.read().find(i => i.id === +b.dataset.inc);
    Cart.setQty(l.id, Math.min(10, l.qty + 1));
  });
  body.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
    const l = Cart.read().find(i => i.id === +b.dataset.dec);
    Cart.setQty(l.id, l.qty - 1);
  });

  foot.innerHTML = `
    <div class="totals"><span>Total</span><span>${rupees(Cart.total())}</span></div>
    <div class="stack">
      <input class="field" id="cName" placeholder="Your name" autocomplete="name">
      <input class="field" id="cPhone" placeholder="Phone number" inputmode="tel" autocomplete="tel">
      <input class="field" id="cNote" placeholder="Occasion or date (optional)">
      <button class="btn wide" id="place">Send enquiry on WhatsApp</button>
      <p class="muted" style="font-size:.8rem;margin:0;text-align:center">
        Nothing is charged here. We confirm price and delivery on WhatsApp.</p>
      <div id="orderMsg"></div>
    </div>`;
  $('place').onclick = placeOrder;
}

async function placeOrder() {
  const btn = $('place'), msg = $('orderMsg');
  const payload = {
    name: $('cName').value.trim(),
    phone: $('cPhone').value.trim(),
    note: $('cNote').value.trim(),
    items: Cart.read().map(i => ({ id: i.id, qty: i.qty }))
  };
  if (!payload.name || !payload.phone) {
    msg.innerHTML = '<p class="note bad">Add your name and phone number so we can reply.</p>';
    return;
  }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send the enquiry.');
    msg.innerHTML = `<p class="note good">Enquiry ${data.ref} is with us. Opening WhatsApp…</p>`;
    localStorage.removeItem('sw_bag');
    window.open(data.whatsapp, '_blank', 'noopener');
    setTimeout(paintBag, 2500);
  } catch (err) {
    msg.innerHTML = `<p class="note bad">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Send enquiry on WhatsApp';
  }
}

function openBag(open) {
  const drawer = $('drawer'), scrim = $('scrim');
  if (!drawer || !scrim) return;
  drawer.classList.toggle('open', open);
  scrim.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

/* ---------------------------- wiring ------------------------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

if (grid) {
  $('q').oninput = debounce(e => { state.q = e.target.value.trim(); load(); });
  $('sort').onchange = e => { state.sort = e.target.value; load(); };
  $('minPrice').oninput = debounce(e => { state.min = +e.target.value || 0; load(); }, 500);
  $('maxPrice').oninput = debounce(e => { state.max = +e.target.value || 0; load(); }, 500);
  $('inStock').onchange = e => { state.inStock = e.target.checked; load(); };
  $('more').onclick = () => { state.page++; load(true); };
  $('clearFilters').onclick = () => {
    Object.assign(state, { q: '', collection: '', min: 0, max: 0, inStock: false, page: 1 });
    $('q').value = ''; $('minPrice').value = ''; $('maxPrice').value = ''; $('inStock').checked = false;
    loadFacets(); load();
  };
  document.querySelectorAll('.topnav a[data-filter]').forEach(a => a.onclick = () => {
    state.collection = a.dataset.filter;
    document.querySelectorAll('.topnav a').forEach(x => x.removeAttribute('aria-current'));
    a.setAttribute('aria-current', 'page');
    loadFacets(); load();
  });
  loadFacets(); load();
}

// Guarded: a page without the drawer markup should still work.
const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
on('openBag', () => openBag(true));
on('closeBag', () => openBag(false));
on('scrim', () => openBag(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') openBag(false); });
try { paintBag(); } catch (err) { console.error('Bag render failed:', err); }

window.SeWeaves = { Cart, openBag, rupees, esc, thumb, COLLECTION_LABEL };
