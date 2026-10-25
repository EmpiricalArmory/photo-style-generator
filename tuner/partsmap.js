// Parts maps: an image of a photo with its parts painted in colours of your own choosing. This finds the colours
// painted, guesses which part each one is (or takes it from your colour key), and turns them into the parts.
// What isn't painted (transparent, or left as the photo when the map was painted over a copy of it) is the
// background, or is left to the auto split. Pure functions on typed arrays; the app does the drawing.
import { srgb255ToLab, hexToRgb, rgbToHex, boxMean } from '../shared/imgproc.js';

// ---------- names: gloves-mask.png (or gloves_parts.png, gloves map.png…) is the map for gloves.jpg ----------
export const baseName = (name) => String(name || '').split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '');
export const looseKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const MAP_NAME = /^(.+?)[\s._-]+(?:parts[\s._-]*map|parts|mask|map)$/i;
export const photoKeyOfMap = (fileName) => { const m = baseName(fileName).match(MAP_NAME); return m && looseKey(m[1]) ? looseKey(m[1]) : null; };
export const photoKeyOf = (fileName) => looseKey(baseName(fileName));

// ---------- colours ----------
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const hsv = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d > 0) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx > 0 ? d / mx : 0, mx];
};
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
// a colour's nearest part by hue, on the colour wheel: red the product, orange to yellow skin, green the background,
// cyan to blue generic gear, violet to magenta steel (the tool's own colours sit on these)
const HUES = [['gear', 0], ['skin', 45], ['place', 120], ['kit', 220], ['steel', 280]];
const isNeutral = (c) => { const [, s] = hsv(c.rgb); return Math.hypot(c.lab[1], c.lab[2]) < 14 || s < 0.18; };

// guesses for a map's colours (largest first): one colour alone is the product (or, covering most of the photo, the
// background); black and white alone are a subject mask, the lighter the product; the largest grey, black or white is
// the background, a mid grey steel, the neutral opposite the background the product; any other colour by its hue
export const guessParts = (colours, n) => {
  const K = colours.length; if (!K) return [];
  if (K === 1) return [colours[0].count > 0.6 * n ? 'place' : 'gear'];
  const neutral = colours.map(isNeutral);
  if (K === 2 && neutral[0] && neutral[1]) { const lighter = colours[0].lab[0] >= colours[1].lab[0] ? 0 : 1; return colours.map((c, i) => (i === lighter ? 'gear' : 'place')); }
  let big = -1; colours.forEach((c, i) => { if (neutral[i] && (big < 0 || c.count > colours[big].count)) big = i; });
  return colours.map((c, i) => {
    if (neutral[i]) {
      if (i === big) return 'place';
      const L = c.lab[0];
      if (L >= 22 && L <= 82) return 'steel';
      return big >= 0 && Math.abs(L - colours[big].lab[0]) > 50 ? 'gear' : 'place';
    }
    const [h] = hsv(c.rgb); let best = 'gear', bd = 1e9;
    for (const [p, a] of HUES) { const d = hueDist(h, a); if (d < bd) { bd = d; best = p; } }
    return best;
  });
};

// the part for each colour: from the key (your own choices, matched within ΔE 18), or the guess
export const KEY_MATCH = 18;
export const keyEntryFor = (key, lab) => {
  let best = null, bd = KEY_MATCH * KEY_MATCH;
  for (const e of key || []) { const d = d2(srgb255ToLab(hexToRgb(e.hex)), lab); if (d < bd) { bd = d; best = e; } }
  return best;
};
export const partsFor = (colours, key, n) => {
  const guess = guessParts(colours, n);
  return colours.map((c, i) => { const e = keyEntryFor(key, c.lab); return e ? { part: e.part, from: 'key' } : { part: guess[i], from: 'guess' }; });
};
// your choice for a colour replaces any key entry near it
export const setKey = (key, rgb, part) => {
  const lab = srgb255ToLab(rgb);
  const out = (key || []).filter((e) => d2(srgb255ToLab(hexToRgb(e.hex)), lab) >= KEY_MATCH * KEY_MATCH);
  out.push({ hex: rgbToHex(rgb), part });
  return out;
};

// ---------- reading a map ----------
// near: the map at the working size without smoothing (its colours exactly as painted); smooth: the map scaled as the
// photo was, to compare with photo (the photo at the working size). All RGBA, w × h.
export const analyseMap = ({ near, smooth = null, photo = null, w, h }) => {
  const n = w * h, T = 20; // left as the photo: no channel more than T from it
  // 1 · what isn't painted: transparent pixels, or pixels left as the photo
  let transparent = 0;
  for (let j = 3; j < near.length; j += 4) if (near[j] < 128) transparent++;
  const NB = 32768, binOf = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const match = new Uint8Array(n);
  let mode = 'flat';
  if (transparent >= 0.005 * n) mode = 'layer';
  else if (photo && smooth) {
    // painted over a copy of the photo: a good share of it is the photo itself, to within compression (a flat map
    // can match the photo here and there too, but not that closely: its colours are flat, the photo's aren't)
    let matched = 0, dsum = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const d = Math.max(Math.abs(smooth[j] - photo[j]), Math.abs(smooth[j + 1] - photo[j + 1]), Math.abs(smooth[j + 2] - photo[j + 2]));
      if (d <= T) { match[i] = 1; matched++; dsum += d; }
    }
    if (matched >= 0.05 * n && dsum / matched <= 5) mode = 'over';
  }
  const unpainted = (i, j) => (mode === 'layer' ? near[j + 3] < 128 : mode === 'over' ? match[i] === 1 : false);

  // 2 · the painted colours: a histogram (32 levels a channel), then colours grown from the densest bins, each taking
  // the bins within ΔE 13 of it (paint, its noise and compression); bins too sparse to start a colour join the nearest
  const cnt = new Uint32Array(NB), sr = new Float64Array(NB), sg = new Float64Array(NB), sb = new Float64Array(NB);
  const bins = new Int32Array(n); let painted = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = near[j], g = near[j + 1], b = near[j + 2], k = binOf(r, g, b);
    if (unpainted(i, j)) { bins[i] = -1; continue; }
    bins[i] = k; cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b; painted++;
  }
  if (painted < Math.max(16, n * 0.0005)) return { labels: null, colours: [], mode, unmarked: 1, error: mode === 'over' ? 'nothing is painted on it: it matches the photo everywhere' : 'nothing is painted on it' };
  const used = []; for (let k = 0; k < NB; k++) if (cnt[k]) used.push(k);
  used.sort((a, b) => cnt[b] - cnt[a]);
  const labOf = new Map(); const binLab = (k) => { let v = labOf.get(k); if (!v) { v = srgb255ToLab([sr[k] / cnt[k], sg[k] / cnt[k], sb[k] / cnt[k]]); labOf.set(k, v); } return v; };
  const minSeed = Math.max(24, Math.round(painted * 0.0004)), JOIN = 13 * 13;
  let C = []; const asg = new Int16Array(NB).fill(-1);
  for (const k of used) {
    const lab = binLab(k); let bk = -1, bd = JOIN;
    for (let q = 0; q < C.length; q++) { const d = d2(lab, C[q].seed); if (d < bd) { bd = d; bk = q; } }
    if (bk < 0 && cnt[k] >= minSeed && C.length < 64) { C.push({ seed: lab, r: 0, g: 0, b: 0, count: 0 }); bk = C.length - 1; }
    if (bk < 0) continue;
    asg[k] = bk; const c = C[bk]; c.r += sr[k]; c.g += sg[k]; c.b += sb[k]; c.count += cnt[k];
  }
  if (!C.length) { const k = used[0]; C.push({ seed: binLab(k), r: sr[k], g: sg[k], b: sb[k], count: cnt[k] }); asg[k] = 0; }
  const meanLab = (c) => srgb255ToLab([c.r / c.count, c.g / c.count, c.b / c.count]);
  C.forEach((c) => { c.lab = meanLab(c); });
  // at most twelve colours: the smallest join their nearest
  const mergeInto = (from, to) => { C[to].r += C[from].r; C[to].g += C[from].g; C[to].b += C[from].b; C[to].count += C[from].count; C[to].lab = meanLab(C[to]); };
  const remap = new Int16Array(C.length).map((_, q) => q);
  const alive = C.map(() => true);
  const nearestAlive = (lab, skip = -1) => { let bk = -1, bd = Infinity; C.forEach((c, q) => { if (!alive[q] || q === skip) return; const d = d2(lab, c.lab); if (d < bd) { bd = d; bk = q; } }); return [bk, bd]; };
  while (alive.filter(Boolean).length > 12) {
    let s = -1; C.forEach((c, q) => { if (alive[q] && (s < 0 || c.count < C[s].count)) s = q; });
    const [to] = nearestAlive(C[s].lab, s); mergeInto(s, to); alive[s] = false; remap.forEach((v, q) => { if (v === s) remap[q] = to; });
  }
  // sparse bins: to the nearest colour (within ΔE 45 where there is an unpainted alternative)
  const FAR = mode === 'flat' ? Infinity : 45 * 45;
  for (const k of used) {
    if (asg[k] >= 0) { asg[k] = remap[asg[k]]; continue; }
    const [q, d] = nearestAlive(binLab(k)); asg[k] = d <= FAR ? q : -1;
  }

  // 3 · a label a pixel: the colour's index, or -1 for unpainted
  const labels = new Int8Array(n);
  for (let i = 0; i < n; i++) labels[i] = bins[i] < 0 ? -1 : asg[bins[i]];
  if (mode === 'over') {
    // paint that happens to equal the photo underneath (white paint on a white glove) is still paint: pixels left as
    // the photo that are a painted colour exactly (within that colour's own spread, as compression leaves it) and
    // touch it take it. The photo's own near colours (a white sweep beside the white glove) vary too much to pass.
    const K = C.length, mean = C.map((c) => [c.r / c.count, c.g / c.count, c.b / c.count]), hist = Array.from({ length: K }, () => new Uint32Array(256));
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const L = labels[i]; if (L < 0) continue; const m = mean[L];
      hist[L][Math.min(255, Math.round(Math.max(Math.abs(near[j] - m[0]), Math.abs(near[j + 1] - m[1]), Math.abs(near[j + 2] - m[2]))))]++;
    }
    const tol = hist.map((hh, q) => { let tot = 0; for (const v of hh) tot += v; let acc = 0; for (let d = 0; d < 256; d++) { acc += hh[d]; if (acc >= 0.9 * tot) return Math.max(3, Math.min(8, d)); } return 3; });
    const queue = new Int32Array(n); let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (labels[i] >= 0) queue[qt++] = i;
    while (qh < qt) {
      const i = queue[qh++], L = labels[i], x = i % w, m = mean[L], t = tol[L];
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (j < 0 || labels[j] !== -1) continue;
        const o = j * 4;
        if (Math.abs(near[o] - m[0]) <= t && Math.abs(near[o + 1] - m[1]) <= t && Math.abs(near[o + 2] - m[2]) <= t) { labels[j] = L; queue[qt++] = j; }
      }
    }
  }
  // 4 · tidy: colours that are only the blend along the edge between two others (thin, and between them in colour)
  // are given to their neighbours; then specks and pinholes go to what surrounds them
  const tally = () => {
    const count = new Float64Array(C.length), inner = new Float64Array(C.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, L = labels[i]; if (L < 0) continue; count[L]++;
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && labels[i - 1] === L && labels[i + 1] === L && labels[i - w] === L && labels[i + w] === L) inner[L]++;
    }
    return { count, inner };
  };
  let { count, inner } = tally();
  const solid = C.map((c, q) => alive[q] && count[q] > 0 && inner[q] / count[q] >= 0.2);
  const between = (p, a, b) => { // distance² from p to the segment a–b in Lab
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2; let t = L2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2 : 0; t = Math.max(0, Math.min(1, t));
    return d2(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
  };
  const blend = new Uint8Array(C.length), rgbOf = (c) => [c.r / c.count, c.g / c.count, c.b / c.count];
  C.forEach((c, q) => {
    if (!alive[q] || solid[q] || count[q] === 0) return;
    if (count[q] < 0.0002 * n) { blend[q] = 1; return; }
    if (count[q] > 0.03 * n) return;
    const crgb = rgbOf(c);
    for (let a = 0; a < C.length; a++) if (solid[a] && a !== q && d2(c.lab, C[a].lab) < 900) { blend[q] = 1; return; } // a shade of a colour, along its edge
    for (let a = 0; a < C.length; a++) for (let b = a + 1; b < C.length; b++) {
      if (!solid[a] || !solid[b] || a === q || b === q) continue;
      if (between(crgb, rgbOf(C[a]), rgbOf(C[b])) < 196 || between(c.lab, C[a].lab, C[b].lab) < 144) { blend[q] = 1; return; }
    }
  });
  if (blend.some(Boolean)) {
    for (let i = 0; i < n; i++) if (labels[i] >= 0 && blend[labels[i]]) labels[i] = -2;
    for (let pass = 0; pass < 8; pass++) {
      let left = 0; const upd = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (labels[i] !== -2) continue;
        const votes = new Map();
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const L = labels[yy * w + xx]; if (L !== -2) votes.set(L, (votes.get(L) || 0) + 1);
        }
        if (votes.size) { let bl = -1, bv = -1; for (const [L, v] of votes) if (v > bv) { bv = v; bl = L; } upd.push(i, bl); } else left++;
      }
      for (let u = 0; u < upd.length; u += 2) labels[upd[u]] = upd[u + 1];
      if (!left) break;
    }
    for (let i = 0; i < n; i++) if (labels[i] === -2) labels[i] = -1;
    blend.forEach((v, q) => { if (v) alive[q] = false; });
  }
  // specks: connected areas (of one label, unpainted included) smaller than about 0.004% of the photo take the label
  // around them; over a photo, thin threads of colour along its own edges (compression) are unpainted too
  const minSpeck = Math.max(12, Math.round(n * 0.00004));
  {
    const comp = new Int32Array(n).fill(-1), stack = new Int32Array(n), area = [], lab = [], innerC = [];
    for (let i = 0; i < n; i++) {
      if (comp[i] >= 0) continue;
      const L = labels[i], id = area.length; let sp = 0, a = 0, inn = 0; stack[sp++] = i; comp[i] = id;
      while (sp) {
        const j = stack[--sp], x = j % w; a++; let same = 0;
        if (x > 0) { if (labels[j - 1] === L) { same++; if (comp[j - 1] < 0) { comp[j - 1] = id; stack[sp++] = j - 1; } } }
        if (x < w - 1) { if (labels[j + 1] === L) { same++; if (comp[j + 1] < 0) { comp[j + 1] = id; stack[sp++] = j + 1; } } }
        if (j >= w) { if (labels[j - w] === L) { same++; if (comp[j - w] < 0) { comp[j - w] = id; stack[sp++] = j - w; } } }
        if (j < n - w) { if (labels[j + w] === L) { same++; if (comp[j + w] < 0) { comp[j + w] = id; stack[sp++] = j + w; } } }
        if (same === 4) inn++;
      }
      area.push(a); lab.push(L); innerC.push(inn);
    }
    const fix = new Map(); // component -> votes of the labels round it
    const small = (c) => area[c] < minSpeck || (mode === 'over' && lab[c] >= 0 && area[c] < 6 * minSpeck && innerC[c] < 0.25 * area[c]);
    for (let i = 0; i < n; i++) {
      const c = comp[i]; if (!small(c)) continue;
      let v = fix.get(c); if (!v) { v = new Map(); fix.set(c, v); }
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (j < 0 || comp[j] === c) continue; const L = labels[j]; v.set(L, (v.get(L) || 0) + 1);
      }
    }
    const to = new Map();
    for (const [c, v] of fix) {
      let bl = lab[c], bv = -1; for (const [L, k] of v) if (k > bv) { bv = k; bl = L; }
      if (mode === 'over' && lab[c] >= 0 && area[c] >= minSpeck) bl = -1; // a thread along the photo's edges: unpainted
      to.set(c, bl);
    }
    if (to.size) for (let i = 0; i < n; i++) { const t = to.get(comp[i]); if (t !== undefined) labels[i] = t; }
  }

  // 5 · the colours that remain, largest first; a small one close to a larger one (ΔE 20) is a shade of it
  ({ count } = tally());
  for (let pass = 0; pass < 2; pass++) {
    const live = C.map((c, q) => q).filter((q) => alive[q] && count[q] > 0), into = new Int16Array(C.length).fill(-1);
    for (const q of live) {
      if (count[q] >= 0.01 * n) continue;
      let best = -1, bd = 400;
      for (const a of live) if (a !== q && count[a] > count[q] && into[a] < 0) { const d = d2(C[q].lab, C[a].lab); if (d < bd) { bd = d; best = a; } }
      if (best >= 0) { into[q] = best; alive[q] = false; }
    }
    if (!into.some((v) => v >= 0)) break;
    for (let i = 0; i < n; i++) { const L = labels[i]; if (L >= 0 && into[L] >= 0) labels[i] = into[L]; }
    ({ count } = tally());
  }
  const order = C.map((c, q) => q).filter((q) => alive[q] && count[q] > 0).sort((a, b) => count[b] - count[a]);
  const re = new Int8Array(C.length).fill(-1); order.forEach((q, k) => { re[q] = k; });
  let unmarked = 0;
  for (let i = 0; i < n; i++) { const L = labels[i]; if (L < 0) { unmarked++; continue; } labels[i] = re[L]; }
  const colours = order.map((q) => { const c = C[q], rgb = [c.r / c.count, c.g / c.count, c.b / c.count].map((v) => Math.round(v)); return { rgb, hex: rgbToHex(rgb), lab: srgb255ToLab(rgb), count: count[q], share: count[q] / n }; });
  if (!colours.length) return { labels: null, colours: [], mode, unmarked: 1, error: 'nothing is painted on it' };
  return { labels, colours, mode, unmarked: unmarked / n };
};

// ---------- the parts from a map ----------
// guided filter for several masks with one guide (He et al.): snaps each to the photo's edges
const guidedMany = (I, chans, w, h, r, eps) => {
  const n = w * h, II = new Float32Array(n); for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
  const mI = boxMean(I, w, h, r), mII = boxMean(II, w, h, r), vI = new Float32Array(n);
  for (let i = 0; i < n; i++) vI[i] = mII[i] - mI[i] * mI[i] + eps;
  const Ip = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n);
  return chans.map((p) => {
    for (let i = 0; i < n; i++) Ip[i] = I[i] * p[i];
    const mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r);
    for (let i = 0; i < n; i++) { a[i] = (mIp[i] - mI[i] * mp[i]) / vI[i]; b[i] = mp[i] - a[i] * mI[i]; }
    const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r), q = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = ma[i] * I[i] + mb[i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    return q;
  });
};
// snap one-hot parts (ch: each pixel's part, 0..K-1) to the photo's edges. Only blocks within reach of a boundary are
// filtered (elsewhere the filter would change nothing), each with a margin wide enough to give the whole-photo result;
// in each, every part present but one is filtered and that one is what's left
const snapParts = (ch, K, Ly, w, h) => {
  const n = w * h, r = Math.max(2, Math.round(Math.max(w, h) / 500)), eps = 2e-3, B = 64, M = 3 * r, reach = 2 * r;
  const cov = Array.from({ length: K }, (_, k) => { const f = new Float32Array(n); for (let i = 0; i < n; i++) if (ch[i] === k) f[i] = 1; return f; });
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B), mark = new Uint8Array(bw * bh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, c = ch[i];
    if ((x + 1 < w && ch[i + 1] !== c) || (y + 1 < h && ch[i + w] !== c)) {
      const bx0 = Math.max(0, Math.floor((x - reach) / B)), bx1 = Math.min(bw - 1, Math.floor((x + 1 + reach) / B));
      const by0 = Math.max(0, Math.floor((y - reach) / B)), by1 = Math.min(bh - 1, Math.floor((y + 1 + reach) / B));
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) mark[by * bw + bx] = 1;
    }
  }
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (!mark[by * bw + bx]) continue;
    const x0 = bx * B, y0 = by * B, x1 = Math.min(w, x0 + B), y1 = Math.min(h, y0 + B);
    const rx0 = Math.max(0, x0 - M), ry0 = Math.max(0, y0 - M), rx1 = Math.min(w, x1 + M), ry1 = Math.min(h, y1 + M), rw = rx1 - rx0, rh = ry1 - ry0;
    const I = new Float32Array(rw * rh), seen = new Uint32Array(K);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = (ry0 + y) * w + rx0 + x; I[y * rw + x] = Ly[i]; seen[ch[i]]++; }
    const here = []; for (let k = 0; k < K; k++) if (seen[k]) here.push(k);
    if (here.length < 2) continue;
    here.sort((a, b2) => seen[b2] - seen[a]); const rest = here[0], filt = here.slice(1);
    const P = filt.map((k) => { const f = new Float32Array(rw * rh); for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (ch[(ry0 + y) * w + rx0 + x] === k) f[y * rw + x] = 1; return f; });
    const Q = guidedMany(I, P, rw, rh, r, eps);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const li = (y - ry0) * rw + (x - rx0), i = y * w + x; let s = 0;
      for (let q = 0; q < filt.length; q++) s += Q[q][li];
      const scale = s > 1 ? 1 / s : 1;
      for (const k of here) cov[k][i] = 0;
      for (let q = 0; q < filt.length; q++) cov[filt[q]][i] = Q[q][li] * scale;
      cov[rest][i] = Math.max(0, 1 - s * scale);
    }
  }
  return cov;
};

// labels (a colour index, or -1 unpainted) and each colour's part -> the masks the engine reads (bytes, 0..255):
// G the product (with steel), P the person (generic gear and skin) of what isn't product, S skin's share of the person,
// ST steel's share of the product, F the subject. Unpainted is the background, or the auto split's parts (auto). Ly, if
// given, snaps the parts' edges to the photo's.
export const PART_IDS = ['gear', 'kit', 'skin', 'steel', 'place'];
export const masksFromMap = ({ labels, parts, w, h, unmarked = 'place', auto = null, Ly = null }) => {
  const n = w * h, useAuto = unmarked === 'auto' && auto;
  const ids = [...PART_IDS, 'auto'], idx = Object.fromEntries(ids.map((p, k) => [p, k]));
  const labelTo = parts.map((p) => idx[p] ?? idx.place), unTo = useAuto ? idx.auto : idx.place;
  const present = new Set(); for (let i = 0; i < n; i++) present.add(labels[i] < 0 ? unTo : labelTo[labels[i]]);
  const chans = [...present].sort((a, b) => a - b), at = new Int8Array(ids.length).fill(-1); chans.forEach((c, k) => { at[c] = k; });
  const ch = new Uint8Array(n); for (let i = 0; i < n; i++) ch[i] = at[labels[i] < 0 ? unTo : labelTo[labels[i]]];
  const cov = Ly && chans.length > 1 ? snapParts(ch, chans.length, Ly, w, h)
    : chans.map((c, k) => { const f = new Float32Array(n); for (let i = 0; i < n; i++) if (ch[i] === k) f[i] = 1; return f; });
  const C = (id) => { const k = chans.indexOf(idx[id]); return k < 0 ? null : cov[k]; };
  const cg = C('gear'), ck = C('kit'), cs = C('skin'), cst = C('steel'), ca = useAuto ? C('auto') : null;
  const G = new Uint8Array(n), P = new Uint8Array(n), S = new Uint8Array(n), ST = new Uint8Array(n), F = new Uint8Array(n);
  const u8 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  for (let i = 0; i < n; i++) {
    let wp = (cg ? cg[i] : 0) + (cst ? cst[i] : 0), wst = cst ? cst[i] : 0, wk = ck ? ck[i] : 0, ws = cs ? cs[i] : 0;
    if (ca && ca[i] > 0) { // the auto split's parts, in proportion, where nothing is painted
      const a = ca[i], g = auto.G[i] / 255, pe = (auto.P[i] / 255) * (1 - g), sk = pe * (auto.S[i] / 255);
      wp += a * g; wst += a * g * (auto.ST[i] / 255); wk += a * (pe - sk); ws += a * sk;
    }
    const pers = wk + ws;
    G[i] = u8(wp); ST[i] = wp > 1e-4 ? u8(wst / wp) : 0;
    P[i] = wp < 0.9999 ? u8(pers / (1 - wp)) : 0; S[i] = pers > 1e-4 ? u8(ws / pers) : 0;
    F[i] = u8(wp + pers);
  }
  return { G, P, S, ST, F };
};
