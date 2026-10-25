// The tuner's engine: the two inks (D116), the toned colour laid back in (D121), and the colour tuned part by part.
// This file holds the analysis that runs once per photo or per edit, and a CPU renderer that mirrors the GPU shader
// (gl.js) exactly, used as the reference in tests and as the fallback where WebGL 2 is missing.
import { INK, CREAM, SUB, hexToRgb, lin8, linToLab, labToSrgb255, sm, clamp01, boxMean, histogram, histPercentile, grainNoiseAt, srgbToLinear } from '../shared/imgproc.js';

// colour strengths: k scales the photo's chroma, cools (greens to purples) are scaled further by `cool`,
// and the strongest colours roll off with a soft knee (0 = no knee)
export const STRENGTHS = {
  ink: { k: 0, knee: 0, cool: 1 },
  quiet: { k: 0.35, knee: 30, cool: 0.5 },
  toned: { k: 0.7, knee: 30, cool: 0.6 },
  strong: { k: 0.85, knee: 45, cool: 0.8 },
  true: { k: 1, knee: 0, cool: 1 },
};
export const STRENGTH_LABELS = [['ink', 'Ink only'], ['quiet', 'Quieter'], ['toned', 'Toned'], ['strong', 'Stronger'], ['true', 'True colour']];
export const PART_KEYS = ['place', 'gear', 'kit', 'skin'];

const part = (name) => ({ preset: name, ...STRENGTHS[name] });
export const MIXES = [
  { id: 'decided', label: 'As decided', note: 'toned everywhere (D121)', parts: { place: 'toned', gear: 'toned', kit: 'toned', skin: 'toned' }, fade: 0 },
  { id: 'forward', label: 'Product forward', note: 'the product stronger, the rest quieter', parts: { place: 'quiet', gear: 'strong', kit: 'quiet', skin: 'toned' }, fade: 0 },
  { id: 'stage', label: 'Quiet stage', note: 'the background faded, the generic gear in ink', parts: { place: 'quiet', gear: 'toned', kit: 'ink', skin: 'quiet' }, fade: 0.5 },
  { id: 'only', label: 'Only what’s for sale', note: 'the product in true colour, the rest in ink', parts: { place: 'ink', gear: 'true', kit: 'ink', skin: 'ink' }, fade: 0 },
];

export const defaultParams = () => ({
  ink: {
    type: 'fine',
    fine: { blackPct: 0.4, whitePct: 99.7, whiteFromPlace: false, curve: 0.3, roll: 0.08, dither: true },
    story: { blackPct: 0, whitePct: 99.3, gamma: 0.95, grain: 0.24, grainSize: 0.7, roll: 0.12 },
    colours: { ink: '#1F1B16', paper: '#E6DFCF', sub: '#FAF8F3' },
  },
  wb: { mode: 'auto', strength: 1, pick: null },
  parts: { place: part('toned'), gear: part('toned'), kit: part('toned'), skin: part('toned') },
  fade: 0,
  bg: { mode: 'keep', fill: '#E6DFCF', shadows: 0 },
});

export const applyMix = (params, mix) => {
  for (const k of PART_KEYS) params.parts[k] = part(mix.parts[k]);
  params.fade = mix.fade;
};
export const matchMix = (params) => MIXES.find((m) => PART_KEYS.every((k) => params.parts[k].preset === m.parts[k]) && Math.abs(params.fade - m.fade) < 1e-6)?.id || null;

// ---------- per photo ----------
export const createState = (rgba, w, h) => {
  const n = w * h, Ly = new Float32Array(n), lin = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    Ly[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // on the sRGB values, as the ink recipe says
    lin[i * 3] = lin8[r]; lin[i * 3 + 1] = lin8[g]; lin[i * 3 + 2] = lin8[b];
  }
  return {
    w, h, n, rgba, Ly, lin, lab: null, gains: [1, 1, 1], noise: null, noiseKey: '',
    masks: { G: new Uint8Array(n), P: new Uint8Array(n), S: new Uint8Array(n), ST: new Uint8Array(n) },
    dec: null, version: 0,
  };
};

// white balance (D121 step 2): per-channel gains in linear light that take the median of the brightest near-neutral
// pixels (saturation under 0.22, the top 3%) to grey; strength 1 goes all the way, 0.6 suits a warm room.
// The medians are kept per photo, so the gains can be worked out again without the pixels (a batch).
export const wbAutoMed = (E) => {
  const cand = [], step = Math.max(1, Math.floor(E.n / 400000));
  for (let i = 0; i < E.n; i += step) {
    const j = i * 4, r = E.rgba[j] / 255, g = E.rgba[j + 1] / 255, b = E.rgba[j + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 0.06 || mx > 0.995) continue; // skip black and clipped
    if ((mx - mn) / mx < 0.22) cand.push(i);
  }
  if (cand.length < 50) return null;
  cand.sort((a, b) => E.Ly[b] - E.Ly[a]);
  const top = cand.slice(0, Math.max(50, Math.floor(cand.length * 0.03)));
  return [0, 1, 2].map((c) => { const v = top.map((i) => E.lin[i * 3 + c]).sort((a, b) => a - b); return v[v.length >> 1]; });
};
// the mean colour around a picked point (a grey card, a white sleeve)
export const wbPickMed = (E, pick) => {
  const [px, py] = pick, r = Math.max(2, Math.round(E.w / 400)); const s = [0, 0, 0]; let c = 0;
  for (let y = Math.max(0, py - r); y <= Math.min(E.h - 1, py + r); y++) for (let x = Math.max(0, px - r); x <= Math.min(E.w - 1, px + r); x++) { const i = (y * E.w + x) * 3; s[0] += E.lin[i]; s[1] += E.lin[i + 1]; s[2] += E.lin[i + 2]; c++; }
  return s.map((v) => v / Math.max(1, c));
};
export const gainsFromMed = (med, strength = 1) => {
  if (!med) return [1, 1, 1];
  const grey = (med[0] + med[1] + med[2]) / 3;
  return med.map((m) => Math.max(0.5, Math.min(2, 1 + (grey / Math.max(m, 1e-4) - 1) * strength)));
};
export const computeGains = (E, wb) => {
  if (!wb || wb.mode === 'off') return [1, 1, 1];
  return gainsFromMed(wb.mode === 'pick' && wb.pick ? wbPickMed(E, wb.pick) : wbAutoMed(E), wb.strength ?? 1);
};

export const computeLab = (E, gains) => {
  const lab = E.lab && E.lab.length === E.n * 3 ? E.lab : new Float32Array(E.n * 3);
  const [gr, gg, gb] = gains;
  for (let i = 0; i < E.n; i++) { const j = i * 3; linToLab(Math.min(1, E.lin[j] * gr), Math.min(1, E.lin[j + 1] * gg), Math.min(1, E.lin[j + 2] * gb), lab, j); }
  E.lab = lab; E.gains = gains;
};

// story ink's grain, from each pixel's position (x0, y0: where this piece sits in the whole picture)
export const ensureNoise = (E, sigma, seed = 11, x0 = 0, y0 = 0) => {
  const key = `${E.w}x${E.h}:${sigma}:${seed}:${x0},${y0}`;
  if (E.noiseKey !== key) { E.noise = grainNoiseAt(x0, y0, E.w, E.h, seed, sigma); E.noiseKey = key; }
};

// weights of the four parts: the product wins, then skin, then generic gear; the background is the rest
export const weightsAt = (G, P, S) => { const wp = G, wpers = P * (1 - wp), ws = wpers * S, wk = wpers - ws; return [wp, wk, ws, Math.max(0, 1 - wp - wpers)]; };

// each part's own colour near its edges: the mean colour of its purest pixels nearby (weights^4, radius w/150),
// so a part never takes on its neighbour's colour where they blend; also the foreground's own luminance near the
// edge, used when the background is removed or refilled so no fringe of the old background is left
export const deconRadius = (w) => Math.max(2, Math.round(w / 150));
export const computeDecon = (E, R = deconRadius(E.w)) => { // R: from the whole picture's width when E is a tile of it
  const { w, h, n, masks, lab, Ly } = E;
  const Wb = new Float32Array(n), Wp = new Float32Array(n), Wk = new Float32Array(n), Wf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [wp, wk, , wb] = weightsAt(masks.G[i] / 255, masks.P[i] / 255, masks.S[i] / 255);
    Wb[i] = wb ** 4; Wp[i] = wp ** 4; Wk[i] = wk ** 4; Wf[i] = (1 - wb) ** 4;
  }
  const mean2 = (W) => {
    const A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { A[i] = W[i] * lab[i * 3 + 1]; B[i] = W[i] * lab[i * 3 + 2]; }
    const mW = boxMean(W, w, h, R), mA = boxMean(A, w, h, R), mB = boxMean(B, w, h, R);
    for (let i = 0; i < n; i++) { if (mW[i] > 1e-4) { mA[i] /= mW[i]; mB[i] /= mW[i]; } else { mA[i] = lab[i * 3 + 1]; mB[i] = lab[i * 3 + 2]; } }
    return [mA, mB];
  };
  const [Mba, Mbb] = mean2(Wb), [Mpa, Mpb] = mean2(Wp), [Mka, Mkb] = mean2(Wk);
  const L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = Wf[i] * Ly[i];
  const mWf = boxMean(Wf, w, h, R * 2), mL = boxMean(L, w, h, R * 2), MLyF = new Float32Array(n);
  for (let i = 0; i < n; i++) MLyF[i] = mWf[i] > 1e-4 ? mL[i] / mWf[i] : Ly[i];
  E.dec = { Mba, Mbb, Mpa, Mpb, Mka, Mkb, MLyF };
};

// what a photo's levels are worked out from: the histogram of its luminance, and of its background alone (pixels at
// least 95% background), plus the white balance medians. Kept per photo, so a batch needs no pixels to print previews
export const computeLevels = (E) => {
  const place = new Uint8Array(E.n); let np = 0;
  for (let i = 0; i < E.n; i++) { const [, , , wb] = weightsAt(E.masks.G[i] / 255, E.masks.P[i] / 255, E.masks.S[i] / 255); if (wb >= 0.95) { place[i] = 1; np++; } }
  return { n: E.n, nPlace: np, hist: histogram(E.Ly), histPlace: histogram(E.Ly, place) };
};
export const computeAnalysis = (E, wbMed) => ({ ...computeLevels(E), wbAutoMed: wbMed === undefined ? wbAutoMed(E) : wbMed });

// the ink's black and white points, and the background's own level
export const statsFrom = (A, params) => {
  const f = params.ink.fine, s = params.ink.story;
  const placeMed = A.nPlace > A.n * 0.02 ? histPercentile(A.histPlace, 50) : NaN;
  let fineB = histPercentile(A.hist, f.blackPct), fineW = f.whiteFromPlace && Number.isFinite(placeMed) ? placeMed : histPercentile(A.hist, f.whitePct);
  if (fineW - fineB < 0.01) fineW = Math.min(1, fineB + 0.01);
  let storyW = histPercentile(A.hist, s.whitePct), storyB = s.blackPct > 0 ? histPercentile(A.hist, s.blackPct) : 0;
  if (storyW - storyB < 0.01) storyW = Math.min(1, storyB + 0.01);
  return { fineB, fineW, storyB, storyW, placeRef: Number.isFinite(placeMed) ? Math.max(0.05, placeMed) : Math.max(0.05, fineW), placeShare: A.nPlace / A.n };
};
export const computeStats = (E, params) => statsFrom(computeLevels(E), params);

// numbers handed to the renderers
export const makeUniforms = (params, stats) => {
  const ink = params.ink, story = ink.type === 'story';
  const c = (hex) => hexToRgb(hex).map((v) => v / 255);
  const paper = hexToRgb(ink.colours.paper);
  const LCream = (() => { const o = [0, 0, 0]; linToLab(lin8[paper[0]], lin8[paper[1]], lin8[paper[2]], o, 0); return o[0]; })();
  const S = PART_KEYS.map((k) => { const p = params.parts[k]; return [p.k, p.knee, p.cool]; });
  return {
    inkType: story ? 1 : 0,
    B: story ? stats.storyB : stats.fineB, W: story ? stats.storyW : stats.fineW,
    curve: ink.fine.curve, gamma: ink.story.gamma, grain: ink.story.grain, roll: story ? ink.story.roll : ink.fine.roll,
    inkC: c(ink.colours.ink), paperC: c(ink.colours.paper), subC: c(ink.colours.sub), LCream,
    S, fade: params.fade, bgMode: { keep: 0, transparent: 1, fill: 2 }[params.bg.mode] ?? 0,
    fillC: c(params.bg.fill), shadows: params.bg.shadows, placeRef: stats.placeRef,
    dither: !story && ink.fine.dither ? 1 : 0,
  };
};

// ---------- the colour shaping (D121 step 3) ----------
export const shapeFactor = (a, b, k, knee, cool) => {
  if (!k) return 0;
  const C = Math.hypot(a, b); if (C < 1e-6) return 0;
  let hd = Math.atan2(b, a) * 57.29577951308232; if (hd < 0) hd += 360;
  const wc = sm(165, 200, hd) * (1 - sm(300, 335, hd)), fk = k * (1 - wc * (1 - cool)), Ck = C * fk;
  const Cs = knee > 0 ? knee * Math.tanh(Ck / knee) : Ck;
  return Cs / C;
};

export const ditherHash = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v); };

// one pixel, exactly as the shader does it; returns [r, g, b, a] in 0..255 (straight alpha)
export const shadePixel = (E, U, i, out) => {
  const m = E.masks, d = E.dec, lab = E.lab;
  const [wp, wk, ws, wb] = weightsAt(m.G[i] / 255, m.P[i] / 255, m.S[i] / 255), st = m.ST[i] / 255, fg = 1 - wb;
  const Ly = E.Ly[i];
  let Lu = Ly;
  if (U.bgMode !== 0) { const q = sm(0.6, 0.95, fg); Lu = d.MLyF[i] * (1 - q) + Ly * q; }
  let tp, top;
  if (U.inkType === 0) {
    const raw = (Lu - U.B) / (U.W - U.B), t = clamp01(raw);
    tp = U.curve * t * t * (3 - 2 * t) + (1 - U.curve) * t; top = clamp01((raw - 1) / U.roll);
  } else {
    const tt = Math.min(1.12, Math.max(0, (Lu - U.B) / (U.W - U.B)));
    let c = 1 - Math.pow(Math.min(tt, 1), U.gamma); c = clamp01(c + U.grain * E.noise[i] * c * (1 - c));
    tp = 1 - c; top = clamp01((tt - 1) / U.roll);
  }
  if (U.bgMode === 0 && U.fade > 0) tp = tp + (1 - tp) * U.fade * wb;
  // the ink's colour at this tone, in CIELAB
  const base = [0, 0, 0];
  linToLab(srgbToLinear(U.inkC[0] + (U.paperC[0] - U.inkC[0]) * tp), srgbToLinear(U.inkC[1] + (U.paperC[1] - U.inkC[1]) * tp), srgbToLinear(U.inkC[2] + (U.paperC[2] - U.inkC[2]) * tp), base, 0);
  let L = base[0], a = base[1], b = base[2];
  const A = lab[i * 3 + 1], B = lab[i * 3 + 2];
  const qb = sm(0.6, 0.95, wb), qp = sm(0.6, 0.95, wp), qk = sm(0.6, 0.95, wk);
  const ba = qb * A + (1 - qb) * d.Mba[i], bb = qb * B + (1 - qb) * d.Mbb[i];
  const pa = qp * A + (1 - qp) * d.Mpa[i], pb = qp * B + (1 - qp) * d.Mpb[i];
  const ka = qk * A + (1 - qk) * d.Mka[i], kb = qk * B + (1 - qk) * d.Mkb[i];
  const S = U.S;
  const fb = U.bgMode === 0 && wb > 1e-3 ? wb * shapeFactor(ba, bb, S[0][0], S[0][1], S[0][2]) : 0;
  const fp = wp > 1e-3 ? wp * (1 - st) * shapeFactor(pa, pb, S[1][0], S[1][1], S[1][2]) : 0;
  const fk = wk > 1e-3 ? wk * shapeFactor(ka, kb, S[2][0], S[2][1], S[2][2]) : 0;
  const fs = ws > 1e-3 ? ws * shapeFactor(A, B, S[3][0], S[3][1], S[3][2]) : 0;
  const gt = sm(0, 0.14, tp) * (1 - sm(0.9, 1, tp)) * (1 - top);
  const norm = U.bgMode !== 0 ? 1 / Math.max(fg, 1e-3) : 1;
  if (gt > 0) {
    const da = (fb * ba + fp * pa + fk * ka + fs * A) * gt * norm, db = (fb * bb + fp * pb + fk * kb + fs * B) * gt * norm;
    a += da; b += db; L = Math.max(L, Math.min(L + 0.25 * Math.hypot(da, db), U.LCream));
  }
  labToSrgb255(L, a, b, out, 0);
  const tps = U.bgMode === 0 ? top * (1 - U.fade * wb) : top;
  for (let c = 0; c < 3; c++) out[c] = out[c] * (1 - tps) + U.subC[c] * 255 * tps;
  if (U.dither) { const x = i % E.w, y = (i / E.w) | 0, dv = ditherHash(x, y) - 0.5; for (let c = 0; c < 3; c++) out[c] += dv; }
  out[3] = 255;
  if (U.bgMode === 1) out[3] = 255 * fg;
  else if (U.bgMode === 2) {
    const shade = U.shadows > 0 ? 1 - U.shadows * (1 - clamp01(Ly / U.placeRef)) : 1;
    for (let c = 0; c < 3; c++) out[c] = U.fillC[c] * 255 * shade * (1 - fg) + out[c] * fg;
  }
  return out;
};

export const renderCPU = (E, U) => {
  const img = new ImageData(E.w, E.h), d = img.data, px = [0, 0, 0, 0];
  for (let i = 0, j = 0; i < E.n; i++, j += 4) { shadePixel(E, U, i, px); d[j] = px[0]; d[j + 1] = px[1]; d[j + 2] = px[2]; d[j + 3] = px[3]; }
  return img;
};

export { INK, CREAM, SUB };
