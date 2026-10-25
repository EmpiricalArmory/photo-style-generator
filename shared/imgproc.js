// Image-processing helpers shared by the photo tools: colour conversions, filters, morphology, noise and resizing.
// Everything works on flat typed arrays (one value per pixel, row-major) so it stays fast in plain JavaScript.

export const INK = [31, 27, 22];        // #1F1B16, the warm black
export const CREAM = [230, 223, 207];   // #E6DFCF, the paper
export const SUB = [250, 248, 243];     // #FAF8F3, the substrate

export const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return v;
};
export const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => { c = c < 0 ? 0 : c > 1 ? 1 : c; return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
export const lin8 = (() => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255); return t; })();

const f3 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const inv3 = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);

// linear sRGB (0..1) -> CIELAB (D65), written to out[j..j+2]
export const linToLab = (R, G, B, out, j) => {
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047, Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B, Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = f3(X), fy = f3(Y), fz = f3(Z);
  out[j] = 116 * fy - 16; out[j + 1] = 500 * (fx - fy); out[j + 2] = 200 * (fy - fz);
};
// CIELAB -> sRGB 0..255 (gamut clipped per channel), written to out[j..j+2]
export const labToSrgb255 = (L, a, b, out, j) => {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200, X = inv3(fx) * 0.95047, Y = inv3(fy), Z = inv3(fz) * 1.08883;
  out[j] = 255 * linearToSrgb(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
  out[j + 1] = 255 * linearToSrgb(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z);
  out[j + 2] = 255 * linearToSrgb(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
};
export const srgb255ToLab = (rgb) => { const o = [0, 0, 0]; linToLab(lin8[Math.round(rgb[0])], lin8[Math.round(rgb[1])], lin8[Math.round(rgb[2])], o, 0); return o; };

export const sm = (e0, e1, x) => { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// running-sum mean over a (2r+1)^2 window, edges clamped
export const boxMean = (src, w, h, r) => {
  const n = w * h, tmp = new Float32Array(n), out = new Float32Array(n);
  if (r < 1) { out.set(src); return out; }
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + (x < 0 ? 0 : x >= w ? w - 1 : x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / d;
      const xa = x + r + 1, xr = x - r;
      s += src[row + (xa >= w ? w - 1 : xa)] - src[row + (xr < 0 ? 0 : xr)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / d;
      const ya = y + r + 1, yr = y - r;
      s += tmp[(ya >= h ? h - 1 : ya) * w + x] - tmp[(yr < 0 ? 0 : yr) * w + x];
    }
  }
  return out;
};

// guided filter (He et al.) with a grey guide I; snaps a soft mask p to the photo's edges
export const guided = (I, p, w, h, r, eps) => {
  const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i], c = mIp[i] - mI[i] * mp[i]; a[i] = c / (v + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = ma[i] * I[i] + mb[i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return q;
};

// the same, on a sub-rectangle only (for brush strokes); writes the result back into p within the rectangle
export const guidedRect = (I, p, w, h, x0, y0, x1, y1, r, eps) => {
  x0 = Math.max(0, x0 - 2 * r); y0 = Math.max(0, y0 - 2 * r); x1 = Math.min(w, x1 + 2 * r); y1 = Math.min(h, y1 + 2 * r);
  const sw = x1 - x0, sh = y1 - y0; if (sw < 2 || sh < 2) return;
  const Is = new Float32Array(sw * sh), ps = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const i = (y0 + y) * w + x0 + x; Is[y * sw + x] = I[i]; ps[y * sw + x] = p[i]; }
  const q = guided(Is, ps, sw, sh, r, eps);
  const m = r; // keep a margin untouched so the patch blends in
  for (let y = m; y < sh - m; y++) for (let x = m; x < sw - m; x++) p[(y0 + y) * w + x0 + x] = q[y * sw + x];
};

// percentile of values in [0,1] (optionally only where mask >= 0.5), from a 4096-bin histogram
export const percentile = (arr, p, mask) => {
  const B = 4096, hist = new Uint32Array(B); let n = 0;
  for (let i = 0; i < arr.length; i++) { if (mask && mask[i] < 0.5) continue; const v = arr[i]; hist[v <= 0 ? 0 : v >= 1 ? B - 1 : (v * (B - 1)) | 0]++; n++; }
  if (!n) return NaN;
  const target = (p / 100) * n; let acc = 0;
  for (let b = 0; b < B; b++) { acc += hist[b]; if (acc >= target) return b / (B - 1); }
  return 1;
};

// seeded Gaussian noise, blurred with sigma (px) and scaled back to a standard deviation of 1
export const grainNoise = (w, h, seed = 11, sigma = 0.7) => {
  let s = seed | 0;
  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = w * h, a = new Float32Array(n);
  for (let i = 0; i < n; i += 2) { const u = Math.max(1e-9, rnd()), v = rnd(), m = Math.sqrt(-2 * Math.log(u)); a[i] = m * Math.cos(6.283185307 * v); if (i + 1 < n) a[i + 1] = m * Math.sin(6.283185307 * v); }
  if (sigma <= 0.05) return a;
  const R = Math.max(1, Math.ceil(sigma * 3)), k = [];
  let ks = 0; for (let q = -R; q <= R; q++) { const v = Math.exp(-(q * q) / (2 * sigma * sigma)); k.push(v); ks += v; }
  for (let q = 0; q < k.length; q++) k[q] /= ks;
  const b = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let q = -R; q <= R; q++) { const xx = x + q < 0 ? 0 : x + q >= w ? w - 1 : x + q; v += k[q + R] * a[y * w + xx]; } b[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let q = -R; q <= R; q++) { const yy = y + q < 0 ? 0 : y + q >= h ? h - 1 : y + q; v += k[q + R] * b[yy * w + x]; } a[y * w + x] = v; }
  let ss = 0; for (let i = 0; i < n; i++) ss += a[i] * a[i];
  const sd = Math.sqrt(ss / n) || 1;
  for (let i = 0; i < n; i++) a[i] /= sd;
  return a;
};

// binary morphology with square windows (fast, via box means)
export const dilate = (m, w, h, r) => { const b = boxMean(m, w, h, r), o = new Float32Array(w * h); for (let i = 0; i < o.length; i++) o[i] = b[i] > 1e-4 ? 1 : 0; return o; };
export const erode = (m, w, h, r) => { const b = boxMean(m, w, h, r), o = new Float32Array(w * h); for (let i = 0; i < o.length; i++) o[i] = b[i] > 0.9999 ? 1 : 0; return o; };
export const binarize = (m, t = 0.5) => { const o = new Float32Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] >= t ? 1 : 0; return o; };

// connected components (4-neighbour) of a binary mask; returns labels (Int32, 0 = none) and per-label stats
export const components = (bin, w, h) => {
  const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n), stats = [null];
  let next = 1;
  for (let i = 0; i < n; i++) {
    if (bin[i] < 0.5 || lab[i]) continue;
    let sp = 0; stack[sp++] = i; lab[i] = next;
    let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp) {
      const j = stack[--sp], x = j % w, y = (j / w) | 0; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && bin[j - 1] >= 0.5 && !lab[j - 1]) { lab[j - 1] = next; stack[sp++] = j - 1; }
      if (x < w - 1 && bin[j + 1] >= 0.5 && !lab[j + 1]) { lab[j + 1] = next; stack[sp++] = j + 1; }
      if (y > 0 && bin[j - w] >= 0.5 && !lab[j - w]) { lab[j - w] = next; stack[sp++] = j - w; }
      if (y < h - 1 && bin[j + w] >= 0.5 && !lab[j + w]) { lab[j + w] = next; stack[sp++] = j + w; }
    }
    stats.push({ area, x0, y0, x1, y1 }); next++;
  }
  return { lab, stats };
};

// bilinear resize of a one-channel float array
export const resizeFloat = (src, sw, sh, dw, dh) => {
  if (sw === dw && sh === dh) return Float32Array.from(src);
  const out = new Float32Array(dw * dh), sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx, b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
};

// draw any image source into a canvas of the given size, with good downscaling
export const drawScaled = (src, sw, sh, dw, dh) => {
  const c = document.createElement('canvas'); c.width = dw; c.height = dh;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  if (sw / dw > 2.1 || sh / dh > 2.1) { // halve in steps so the result is not aliased
    let cur = src, cw = sw, ch = sh;
    while (cw / dw > 2.1 || ch / dh > 2.1) {
      const nw = Math.max(dw, Math.round(cw / 2)), nh = Math.max(dh, Math.round(ch / 2));
      const t = document.createElement('canvas'); t.width = nw; t.height = nh;
      const tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high'; tg.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = t; cw = nw; ch = nh;
    }
    g.drawImage(cur, 0, 0, cw, ch, 0, 0, dw, dh);
  } else g.drawImage(src, 0, 0, sw, sh, 0, 0, dw, dh);
  return c;
};

export const toU8 = (f) => { const o = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) { const v = f[i]; o[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); } return o; };
export const toF32 = (u) => { const o = new Float32Array(u.length); for (let i = 0; i < u.length; i++) o[i] = u[i] / 255; return o; };

// k-means in CIELAB with lightness weighted 0.36 (colour matters more than brightness when telling parts apart)
export const kmeans = (pts, K, it = 10) => {
  if (pts.length < K) return pts.slice();
  let C = []; for (let k = 0; k < K; k++) C.push(pts[Math.floor((k + 0.5) / K * pts.length)].slice());
  const asg = new Int32Array(pts.length);
  for (let t = 0; t < it; t++) {
    for (let i = 0; i < pts.length; i++) { let bd = 1e9, bk = 0; for (let k = 0; k < K; k++) { const d = 0.36 * (pts[i][0] - C[k][0]) ** 2 + (pts[i][1] - C[k][1]) ** 2 + (pts[i][2] - C[k][2]) ** 2; if (d < bd) { bd = d; bk = k; } } asg[i] = bk; }
    const acc = C.map(() => [0, 0, 0, 0]); for (let i = 0; i < pts.length; i++) { const a = acc[asg[i]]; a[0] += pts[i][0]; a[1] += pts[i][1]; a[2] += pts[i][2]; a[3]++; }
    C = acc.map((a, k) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : C[k]));
  }
  return C;
};
export const nearest = (C, L, a, b) => { let bd = 1e9; for (const c of C) { const d = 0.36 * (L - c[0]) ** 2 + (a - c[1]) ** 2 + (b - c[2]) ** 2; if (d < bd) bd = d; } return bd; };
