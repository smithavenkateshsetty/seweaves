/* Defensive: if app.js failed to load, fall back to local helpers rather than
 * throwing on line 1 and leaving the page stuck on "Loading...". */
const SW = window.SeWeaves || {};
const esc = SW.esc || (v => String(v ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const rupees = SW.rupees || (n => '\u20B9' + Number(n || 0).toLocaleString('en-IN'));
const thumb = SW.thumb || (s => s ? s.replace(/\.webp$/, '-thumb.webp') : '');
const COLLECTION_LABEL = SW.COLLECTION_LABEL || {
  bridal: 'Bridal specials', party: 'Party wear', festive: 'Festive collection',
  designer: 'Designer wear', blouse: 'Embroidery blouses'
};
const priceHTML = SW.priceHTML || (p => `<p class="bigprice">${rupees(p.final_price ?? p.price)}</p>`);
const Cart = SW.Cart || null;
const openBag = SW.openBag || (() => {});
const slug = location.pathname.split('/').filter(Boolean).pop();
const root = document.getElementById('detail');

let shots = [];      // image paths, order as set in admin
let current = 0;

(async function () {
  try {
    await load();
  } catch (err) {
    // A blank "Loading..." tells the customer nothing. Say what happened.
    console.error('SeWeaves product page:', err);
    root.innerHTML = `<p class="eyebrow">Something went wrong</p>
      <h1 class="h1">This piece would not load.</h1>
      <p class="lede">${esc(err.message || 'Unknown error')}</p>
      <p style="margin-top:26px"><a class="btn" href="/#catalogue">Back to the rail</a></p>`;
  }
})();

async function load() {
  const res = await fetch('/api/products/' + encodeURIComponent(slug));
  if (!res.ok) {
    root.innerHTML = `<p class="eyebrow">Not found</p>
      <h1 class="h1">That piece has moved on.</h1>
      <p class="lede">It may have sold, or the link may be old. The current rail is a click away.</p>
      <p style="margin-top:26px"><a class="btn" href="/#catalogue">See what's in stock</a></p>`;
    return;
  }
  const p = await res.json();
  document.title = `${p.title} — SeWeaves`;
  shots = Array.isArray(p.images) ? p.images : [];
  p.reviews = Array.isArray(p.reviews) ? p.reviews : [];
  render(p);
}

/* ------------------------------ gallery ---------------------------- */
function galleryMarkup() {
  if (!shots.length) {
    return `<div class="gallery"><div></div>
      <div class="stage"><div class="noshot">Photo coming</div></div></div>`;
  }
  const rail = shots.length > 1 ? `<div class="rail" id="rail">${shots.map((s, i) =>
    `<button data-i="${i}" aria-current="${i === 0}" aria-label="View photo ${i + 1}">
       <img src="${thumb(s)}" alt="" loading="lazy"></button>`).join('')}</div>` : '<div></div>';

  const arrows = shots.length > 1 ? `
    <button class="arrow prev" id="prev" aria-label="Previous photo">&#8249;</button>
    <button class="arrow next" id="next" aria-label="Next photo">&#8250;</button>
    <span class="counter" id="counter">1 / ${shots.length}</span>` : '';

  return `<div class="gallery">
    ${rail}
    <div class="stage" id="stage" tabindex="0">
      <img id="mainShot" src="${shots[0]}" alt="Photo 1">
      ${arrows}
      <span class="zoomhint">Hover to zoom · click to enlarge</span>
    </div>
  </div>`;
}

function show(i) {
  if (!shots.length) return;
  current = (i + shots.length) % shots.length;
  const img = document.getElementById('mainShot');
  img.src = shots[current];
  img.alt = `Photo ${current + 1}`;
  const counter = document.getElementById('counter');
  if (counter) counter.textContent = `${current + 1} / ${shots.length}`;
  document.querySelectorAll('#rail button').forEach(b =>
    b.setAttribute('aria-current', +b.dataset.i === current));
  if (lb && lb.classList.contains('open')) paintLightbox();
}

function wireGallery() {
  const stage = document.getElementById('stage');
  if (!stage || !shots.length) return;

  document.querySelectorAll('#rail button').forEach(b =>
    b.onclick = () => show(+b.dataset.i));
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  if (prev) prev.onclick = e => { e.stopPropagation(); show(current - 1); };
  if (next) next.onclick = e => { e.stopPropagation(); show(current + 1); };

  const img = document.getElementById('mainShot');

  // Hover zoom. The stored image is 1200x1600 and displays around 560px wide,
  // so 2.2x is real detail rather than an upscale — you can see the zari.
  const fine = window.matchMedia('(hover:hover) and (pointer:fine)');
  if (fine.matches) {
    stage.addEventListener('mouseenter', () => stage.classList.add('zooming'));
    stage.addEventListener('mousemove', e => {
      const r = stage.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      img.style.transformOrigin = `${x}% ${y}%`;
      img.style.transform = 'scale(2.2)';
    });
    stage.addEventListener('mouseleave', () => {
      stage.classList.remove('zooming');
      img.style.transform = '';
      img.style.transformOrigin = 'center';
    });
  }

  stage.addEventListener('click', e => {
    if (e.target.closest('.arrow')) return;
    openLightbox();
  });

  // Swipe, for phones — most of your customers will be on one.
  let x0 = null, y0 = null;
  stage.addEventListener('touchstart', e => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) show(current + (dx < 0 ? 1 : -1));
    x0 = y0 = null;
  }, { passive: true });

  stage.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(current - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(current + 1); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(); }
  });

  // Preload neighbours so arrowing through feels instant.
  shots.forEach(s => { const i = new Image(); i.src = s; });
}

/* ----------------------------- lightbox ---------------------------- */
const lb = document.getElementById('lightbox');
function paintLightbox() {
  const img = document.getElementById('lbImg');
  if (!img) return;
  img.src = shots[current];
  document.getElementById('lbImg').alt = `Photo ${current + 1}`;
  document.getElementById('lbCount').textContent = `${current + 1} of ${shots.length}`;
}
function openLightbox() {
  if (!shots.length || !lb) return;
  paintLightbox();
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('lbClose').focus();
}
function closeLightbox() {
  if (!lb) return;
  lb.classList.remove('open');
  document.body.style.overflow = '';
}
const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
bind('lbClose', closeLightbox);
bind('lbPrev', () => show(current - 1));
bind('lbNext', () => show(current + 1));
if (lb) lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
document.addEventListener('keydown', e => {
  if (!lb || !lb.classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') show(current - 1);
  if (e.key === 'ArrowRight') show(current + 1);
});

/* ------------------------------ page ------------------------------- */
function render(p) {
  const spec = (k, v) => v ? `<li><span class="k">${k}</span><span class="v">${esc(v)}</span></li>` : '';
  const stars = n => { const k = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '★'.repeat(k) + '☆'.repeat(5 - k); };

  root.innerHTML = `
  <div class="detail">
    ${galleryMarkup()}
    <div>
      <p class="eyebrow">${esc(COLLECTION_LABEL[p.collection] || p.collection)}</p>
      <h1 class="h1">${esc(p.title)}</h1>
      ${p.rating_count ? `<p class="stars">${stars(p.avg_rating)} <small>${p.avg_rating} from ${p.rating_count} ${p.rating_count === 1 ? 'buyer' : 'buyers'}</small></p>` : ''}
      ${priceHTML(p, true)}
      ${p.discount_percent > 0 ? `<p class="savenote">You save ${rupees((p.list_price ?? p.price) - (p.final_price ?? p.price))}${p.discount_source === 'store' ? ' with the launch offer' : ' on this piece'}</p>` : ''}
      ${p.description ? `<p class="lede" style="margin-top:18px">${esc(p.description)}</p>` : ''}

      <ul class="specs">
        ${spec('SKU', p.sku)}
        ${spec('Fabric', p.fabric)}
        ${spec('Colour', p.colour)}
        ${spec('Work', p.work)}
        ${spec('Blouse size', p.blouse_size)}
        <li><span class="k">Availability</span><span class="v">${
          p.stock > 0 ? `${p.stock} in stock` : 'Sold — ask about a similar piece'}</span></li>
      </ul>

      <div class="stack">
        <div class="tilebuy" style="padding-top:0">
          ${p.stock > 0 ? `<div class="qty" id="qtyBox">
            <button type="button" data-step="-1" aria-label="Fewer">−</button>
            <span id="qtyCount">1</span>
            <button type="button" data-step="1" aria-label="More">+</button>
          </div>` : ''}
          <button class="btn" id="add" ${p.stock <= 0 ? 'disabled' : ''}>
            ${p.stock > 0 ? 'Add to bag' : 'Currently sold'}</button>
        </div>
        <p class="muted" style="font-size:.85rem;margin:0">
          Blouse stitched to your measurements on bridal orders. Alterations in-house, 2–3 days.</p>
      </div>

      <div style="margin-top:44px">
        <h2 class="h2">What buyers said</h2>
        ${p.reviews.length
          ? p.reviews.map(r => `<div class="review">
              <p class="stars">${stars(r.rating)}</p>
              <h5>${esc(r.name)}</h5>
              <p class="muted" style="margin:0">${esc(r.body)}</p></div>`).join('')
          : '<p class="muted">No reviews on this piece yet. Yours would be the first.</p>'}

        <div class="stack" style="margin-top:22px;max-width:420px">
          <input class="field" id="rName" placeholder="Your name">
          <select class="field" id="rRating">
            <option value="5">★★★★★ Excellent</option>
            <option value="4">★★★★☆ Good</option>
            <option value="3">★★★☆☆ Fair</option>
            <option value="2">★★☆☆☆ Poor</option>
            <option value="1">★☆☆☆☆ Bad</option>
          </select>
          <textarea class="field" id="rBody" rows="3" placeholder="How was the fabric and the fit?"></textarea>
          <button class="btn ghost" id="sendReview">Leave a review</button>
          <div id="rMsg"></div>
        </div>
      </div>
    </div>
  </div>`;

  wireGallery();

  let qty = 1;
  const cap = Math.min(10, Math.max(1, p.stock || 10));
  document.querySelectorAll('#qtyBox [data-step]').forEach(b => b.onclick = () => {
    qty = Math.max(1, Math.min(cap, qty + (+b.dataset.step)));
    document.getElementById('qtyCount').textContent = qty;
  });

  const add = document.getElementById('add');
  if (add) add.onclick = () => {
    if (!Cart) { alert('The bag is unavailable — please reload the page.'); return; }
    Cart.add(p, qty);
    openBag(true);
  };

  document.getElementById('sendReview').onclick = async () => {
    const msg = document.getElementById('rMsg');
    const body = {
      name: document.getElementById('rName').value.trim(),
      rating: +document.getElementById('rRating').value,
      body: document.getElementById('rBody').value.trim()
    };
    const r = await fetch(`/api/products/${slug}/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await r.json();
    msg.innerHTML = r.ok
      ? '<p class="note good">Thank you — your review appears once the shop approves it.</p>'
      : `<p class="note bad">${esc(data.error)}</p>`;
  };
}
