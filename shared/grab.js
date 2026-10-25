// Send photos to Tuned by part. Run from a bookmark on a page with photos: it lists the page's photos, you tick the
// ones you want, and it opens Tuned by part with them. The photos go straight from this page to that one inside
// your own browser; nothing is uploaded or published. (A site's own photos are theirs: use them to compare.)
(() => {
  const HOST_ID = 'ea-send-photos-host';
  const prior = document.getElementById(HOST_ID); if (prior) prior.remove();
  const me = document.currentScript && document.currentScript.src ? document.currentScript.src : 'https://empiricalarmory.github.io/photo-style-generator/shared/grab.js';
  const TUNER = new URL('../tuner/', me).href, TUNER_ORIGIN = new URL(TUNER).origin;
  const IMG = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;

  // the photos on the page, each at the largest size the page offers (a gallery link to the original, the widest
  // srcset entry, or the WordPress original without its -800x600 suffix, tried first and dropped if missing)
  const found = new Map();
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  const keyOf = (u) => u.replace(/-\d+x\d+(?=\.(jpe?g|png|webp|avif)(\?|#|$))/i, '').replace(/[?#].*$/, '');
  const add = (shown, larger, area) => {
    shown = abs(shown); if (!shown || shown.startsWith('data:')) return;
    const k = keyOf(shown), prev = found.get(k), cands = [];
    for (const u of [larger, keyOf(shown) !== shown.replace(/[?#].*$/, '') ? keyOf(shown) : null, shown]) { const a = u && abs(u); if (a && !cands.includes(a)) cands.push(a); }
    if (!prev) found.set(k, { shown, cands, area });
    else { prev.area = Math.max(prev.area, area); for (const c of cands) if (!prev.cands.includes(c)) prev.cands.splice(prev.cands.length - 1, 0, c); }
  };
  const widest = (srcset) => {
    let best = null, bw = 0;
    for (const part of (srcset || '').split(',')) { const [u, d] = part.trim().split(/\s+/); const w = parseFloat(d) || 0; if (u && w >= bw) { best = u; bw = w; } }
    return best;
  };
  for (const img of document.images) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (Math.max(w, h) < 300 && Math.max(img.width, img.height) < 200) continue;
    const link = img.closest('a[href]'), linked = link && IMG.test(link.getAttribute('href')) ? link.href : null;
    const ss = widest(img.getAttribute('srcset') || img.getAttribute('data-srcset') || (img.parentElement && img.parentElement.tagName === 'PICTURE' ? [...img.parentElement.querySelectorAll('source')].map((s) => s.srcset).join(',') : ''));
    add(img.currentSrc || img.src || img.getAttribute('data-src'), linked || ss, w * h);
  }
  for (const el of document.querySelectorAll('body *')) {
    if (el.offsetWidth < 200 || el.offsetHeight < 150) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) if (IMG.test(m[1])) add(m[1], null, el.offsetWidth * el.offsetHeight);
  }
  const list = [...found.values()].sort((a, b) => b.area - a.area).slice(0, 120);

  // the panel, in its own shadow root so the page's styles leave it alone
  const host = document.createElement('div'); host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .back { position: fixed; inset: 0; background: rgba(31,27,22,.45); }
    .pan { position: fixed; top: 16px; right: 16px; bottom: 16px; width: min(560px, calc(100vw - 32px)); background: #FAF8F3; color: #1F1B16; border-radius: 14px; box-shadow: 0 20px 60px rgba(31,27,22,.4); display: grid; grid-template-rows: auto auto 1fr auto; font: 400 15px/1.4 Cabin, system-ui, -apple-system, 'Segoe UI', sans-serif; overflow: hidden; }
    h2 { font: 400 26px/1.15 'IM Fell English', Georgia, serif; margin: 0; padding: 16px 18px 4px; }
    .sub { padding: 0 18px 10px; color: #5A5148; display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
    .sub button { font: inherit; background: none; border: 0; padding: 0; color: #1F1B16; text-decoration: underline; cursor: pointer; }
    .grid { overflow-y: auto; padding: 4px 18px 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; align-content: start; }
    label { position: relative; display: block; cursor: pointer; border-radius: 8px; overflow: hidden; aspect-ratio: 1; background: #E6DFCF; box-shadow: 0 0 0 1px rgba(31,27,22,.15); }
    label img { width: 100%; height: 100%; object-fit: cover; display: block; transition: opacity .15s; }
    label input { position: absolute; left: 8px; top: 8px; width: 18px; height: 18px; accent-color: #1F1B16; margin: 0; }
    label:has(input:not(:checked)) img { opacity: .35; }
    .foot { border-top: 1px solid rgba(31,27,22,.16); padding: 12px 18px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .msg { flex: 1; color: #5A5148; min-width: 160px; }
    .btn { font: 500 15px/1.2 Cabin, system-ui, sans-serif; border: 1px solid #1F1B16; background: transparent; color: #1F1B16; padding: 8px 14px; border-radius: 999px; cursor: pointer; }
    .btn.primary { background: #1F1B16; color: #FAF8F3; }
    .btn:disabled { opacity: .45; cursor: default; }
    .none { padding: 20px 18px; color: #5A5148; }
  </style>
  <div class="back"></div>
  <div class="pan" role="dialog" aria-label="Send photos to Tuned by part">
    <h2>Send photos to Tuned by part</h2>
    <div class="sub"><span class="count"></span><button type="button" class="all">Tick all</button><button type="button" class="nonebtn">Untick all</button></div>
    <div class="grid"></div>
    <div class="foot"><span class="msg">They open in Tuned by part and stay in your browser only.</span><button type="button" class="btn close">Close</button><button type="button" class="btn primary send">Send</button></div>
  </div>`;
  const $ = (s) => root.querySelector(s), grid = $('.grid'), msg = (t) => { $('.msg').textContent = t; };
  if (!list.length) grid.outerHTML = '<p class="none">No photos large enough were found on this page.</p>';
  for (const [i, it] of list.entries()) {
    const lab = document.createElement('label'); lab.title = it.cands[0];
    lab.innerHTML = '<img alt="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"><input type="checkbox" checked>';
    lab.querySelector('img').src = it.shown; lab.querySelector('input').dataset.i = i;
    grid && grid.appendChild(lab);
  }
  const boxes = () => [...root.querySelectorAll('input[type=checkbox]')];
  const count = () => { const n = boxes().filter((b) => b.checked).length; $('.count').textContent = `${n} of ${list.length} ticked`; $('.send').disabled = !n; $('.send').textContent = n ? `Send ${n}` : 'Send'; };
  root.addEventListener('change', count); count();
  $('.all').onclick = () => { boxes().forEach((b) => { b.checked = true; }); count(); };
  $('.nonebtn').onclick = () => { boxes().forEach((b) => { b.checked = false; }); count(); };
  const close = () => host.remove();
  $('.close').onclick = close; $('.back').onclick = close;
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  const extOf = (type) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' })[type] || 'jpg';
  const nameOf = (url, type, n) => {
    let base = decodeURIComponent((new URL(url).pathname.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '')) || `photo-${n}`;
    base = base.replace(/[^\w.-]+/g, '-').slice(0, 80);
    return `${base}.${extOf(type)}`;
  };
  const fetchImage = async (it) => {
    for (const u of it.cands) {
      try {
        const r = await fetch(u, { credentials: 'same-origin' });
        if (!r.ok) continue;
        const b = await r.blob();
        if (b.type.startsWith('image/') && b.size > 2000) return { blob: b, url: u };
      } catch (e) { /* not readable from here: try the next size */ }
    }
    throw new Error('unreadable');
  };

  $('.send').onclick = async () => {
    const chosen = boxes().filter((b) => b.checked).map((b) => list[+b.dataset.i]);
    if (!chosen.length) return;
    let ready = false, sent = false, photos = null;
    const win = window.open(TUNER, 'ea-tuner'); // opened in the click itself, so it isn't taken for a pop-up
    if (!win) { msg('The browser blocked the new tab. Allow pop-ups for this site, then press Send again.'); return; }
    const post = () => {
      if (sent || !ready || !photos) return;
      sent = true; win.postMessage({ type: 'ea-tuner-photos', photos, from: location.hostname }, TUNER_ORIGIN);
      msg(`Handed ${photos.length} to Tuned by part…`);
    };
    const onMsg = (e) => {
      if (e.source !== win || e.origin !== TUNER_ORIGIN || !e.data) return;
      if (e.data.type === 'ea-tuner-ready') { ready = true; post(); }
      if (e.data.type === 'ea-tuner-received') { msg(`Sent ${e.data.count} to Tuned by part.`); window.removeEventListener('message', onMsg); setTimeout(close, 1800); }
    };
    window.addEventListener('message', onMsg);
    $('.send').disabled = true;
    const got = [], failed = [];
    for (const [k, it] of chosen.entries()) {
      msg(`Reading ${k + 1} of ${chosen.length}…`);
      try { const { blob, url } = await fetchImage(it); got.push({ name: nameOf(url, blob.type, k + 1), blob }); } catch (e) { failed.push(it); }
    }
    if (!got.length) { msg('None of them could be read here: this site doesn’t let other pages read its pictures. Save them to your computer and drop them into Tuned by part.'); window.removeEventListener('message', onMsg); count(); return; }
    photos = got;
    msg(`Read ${got.length}${failed.length ? ` (${failed.length} couldn’t be read)` : ''}. Waiting for Tuned by part to open…`);
    post();
  };
  document.documentElement.appendChild(host);
})();
