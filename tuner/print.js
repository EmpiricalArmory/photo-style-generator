// Printing a photo at any size, in tiles: the photo, its parts (drawn up from the working size), the photo's own
// levels and white balance (kept from the working size), and the settings. Each tile is analysed with a margin around
// it (the edge colours look 1/150 of the width around, the grain is taken from each pixel's position), so tiles join
// without seams and a 24-megapixel photo prints in pieces of about a megapixel. Used for saving at full size and for
// the batch's previews.
import { createState, computeLab, ensureNoise, computeDecon, deconRadius, makeUniforms, renderCPU } from './engine.js';
import { GLRenderer } from './gl.js';

let gl = null;
const renderer = () => {
  if (gl === null) { const r = new GLRenderer(document.createElement('canvas')); gl = r.ok ? r : false; }
  return gl || null;
};

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const ctx = (c) => c.getContext('2d', { willReadFrequently: true });

// the four parts packed into two canvases at the mask size: product, person and skin in RGB, steel in R
export const maskCanvases = (masks, w, h) => {
  const a = canvas(w, h), b = canvas(w, h), ia = new ImageData(w, h), ib = new ImageData(w, h), da = ia.data, db = ib.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    da[j] = masks.G[i]; da[j + 1] = masks.P[i]; da[j + 2] = masks.S[i]; da[j + 3] = 255;
    db[j] = masks.ST[i]; db[j + 1] = 0; db[j + 2] = 0; db[j + 3] = 255;
  }
  ctx(a).putImageData(ia, 0, 0); ctx(b).putImageData(ib, 0, 0);
  return { a, b, w, h };
};

const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

// src: an image, bitmap or canvas (srcW x srcH); mc: maskCanvases(); out: outW x outH.
// stats and gains: the photo's own (statsFrom(analysis), gainsFor()). grainScale shrinks story ink's grain for small
// previews, where the full-size grain would average away
export const renderPrint = async ({ src, srcW, srcH, mc, outW, outH, params, stats, gains, grainScale = 1, tile = 1024, onProgress, into = null }) => {
  const out = into || canvas(outW, outH);
  if (out.width !== outW || out.height !== outH) { out.width = outW; out.height = outH; }
  const og = out.getContext('2d');
  const R = deconRadius(outW), sigma = params.ink.story.grainSize;
  const halo = Math.max(2 * R + 4, Math.ceil(3 * sigma) + 2);
  const U = makeUniforms(params, stats); U.grain *= grainScale;
  const sx = srcW / outW, sy = srcH / outH, mx = mc.w / outW, my = mc.h / outH;
  const tiles = [];
  for (let y = 0; y < outH; y += tile) for (let x = 0; x < outW; x += tile) tiles.push([x, y, Math.min(tile, outW - x), Math.min(tile, outH - y)]);
  const r = renderer();
  let done = 0;
  for (const [tx, ty, tw, th] of tiles) {
    const rx0 = Math.max(0, tx - halo), ry0 = Math.max(0, ty - halo), rx1 = Math.min(outW, tx + tw + halo), ry1 = Math.min(outH, ty + th + halo), rw = rx1 - rx0, rh = ry1 - ry0;
    // the photo
    const pc = canvas(rw, rh), pg = ctx(pc); pg.imageSmoothingEnabled = true; pg.imageSmoothingQuality = 'high';
    pg.drawImage(src, rx0 * sx, ry0 * sy, rw * sx, rh * sy, 0, 0, rw, rh);
    const E = createState(pg.getImageData(0, 0, rw, rh).data, rw, rh);
    // the parts, drawn up (or down) from the mask size
    const ma = canvas(rw, rh), mb = canvas(rw, rh), mga = ctx(ma), mgb = ctx(mb);
    for (const g of [mga, mgb]) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; }
    mga.drawImage(mc.a, rx0 * mx, ry0 * my, rw * mx, rh * my, 0, 0, rw, rh);
    mgb.drawImage(mc.b, rx0 * mx, ry0 * my, rw * mx, rh * my, 0, 0, rw, rh);
    const da = mga.getImageData(0, 0, rw, rh).data, db = mgb.getImageData(0, 0, rw, rh).data, m = E.masks;
    for (let i = 0, j = 0; i < E.n; i++, j += 4) { m.G[i] = da[j]; m.P[i] = da[j + 1]; m.S[i] = da[j + 2]; m.ST[i] = db[j]; }
    computeLab(E, gains); E.lin = null;
    if (params.ink.type === 'story') ensureNoise(E, sigma, 11, rx0, ry0); else E.noise = null;
    computeDecon(E, R);
    let img;
    if (r && r.fits(rw, rh)) { r.upload(E); r.render(U); img = r.read(); }
    else img = renderCPU(E, U);
    og.putImageData(img, rx0, ry0, tx - rx0, ty - ry0, tw, th);
    done++;
    if (tiles.length > 1) { onProgress?.(done / tiles.length); await yieldToPage(); }
  }
  return out;
};
