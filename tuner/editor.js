// The tuner's viewport and part editing: zoom and pan, the parts overlay, brush, lasso and click-to-select,
// and undo. Masks live in the engine state as Uint8 arrays (0..255): G gear, P person (kit and skin), S skin share of
// the person, ST steel share of the gear. The place is whatever is left.
import { guided, guidedRect, boxMean } from '../shared/imgproc.js';

export const PARTS = [
  { id: 'gear', label: 'Gear', key: '1', colour: [170, 54, 17], hint: 'The product for sale' },
  { id: 'kit', label: 'Kit', key: '2', colour: [52, 92, 196], hint: 'Worn gear that isn’t for sale' },
  { id: 'skin', label: 'Skin', key: '3', colour: [236, 178, 52], hint: 'Bare hands and wrists' },
  { id: 'steel', label: 'Steel', key: '4', colour: [0, 150, 160], hint: 'Gear that prints as ink: blades, guards' },
  { id: 'place', label: 'Place', key: '5', colour: null, hint: 'The background: paints the other parts away' },
];

// apply a value a (0..1) of the chosen part at pixel i, adding or erasing
const applyAt = (m, i, a, part, erase) => {
  if (a <= 0) return;
  const A = a * 255, keep = 1 - a;
  if (!erase) {
    if (part === 'gear') { if (m.G[i] < A) m.G[i] = A; }
    else if (part === 'kit') { if (m.P[i] < A) m.P[i] = A; m.G[i] *= keep; m.S[i] *= keep; }
    else if (part === 'skin') { if (m.P[i] < A) m.P[i] = A; if (m.S[i] < A) m.S[i] = A; m.G[i] *= keep; }
    else if (part === 'steel') { if (m.G[i] < A) m.G[i] = A; if (m.ST[i] < A) m.ST[i] = A; }
    else if (part === 'place') { m.G[i] *= keep; m.P[i] *= keep; m.ST[i] *= keep; }
  } else {
    if (part === 'gear') { m.G[i] *= keep; m.ST[i] *= keep; }
    else if (part === 'kit') { m.P[i] *= keep; }
    else if (part === 'skin') { m.S[i] *= keep; }
    else if (part === 'steel') { m.ST[i] *= keep; }
  }
};
const KEYS = ['G', 'P', 'S', 'ST'];

export class Editor {
  constructor({ viewport, stage, glCanvas, overlay, orig, ui, getState, onLive, onCommit, onSmart, onStatus, onPick }) {
    Object.assign(this, { viewport, stage, glCanvas, overlay, orig, ui, getState, onLive, onCommit, onSmart, onStatus, onPick });
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.tool = 'brush'; this.part = 'gear'; this.size = 60; this.soft = 0.5; this.erase = false; this.snap = true;
    this.view = 'result'; this.opacity = 0.55; this.undoStack = []; this.redoStack = []; this.smart = null;
    this.pointer = null; this.spaceDown = false; this.holdOriginal = false; this.picking = false;
    this.octx = overlay.getContext('2d'); this.uctx = ui.getContext('2d');
    this.bind();
  }

  // ---------- view ----------
  setImageSize(w, h) {
    for (const c of [this.overlay, this.orig]) { c.width = w; c.height = h; }
    this.stage.style.width = w + 'px'; this.stage.style.height = h + 'px';
    this.w = w; this.h = h; this.undoStack = []; this.redoStack = []; this.smart = null;
    this.fit();
  }
  fit() {
    if (!this.w) return;
    // Keeps fitting on resize until the person zooms or pans. A hidden or collapsed viewport
    // (a background tab, a closed side panel) has no size yet, so the fit waits for one.
    this.autoFit = true;
    const r = this.viewport.getBoundingClientRect(), pad = 24;
    if (r.width < pad * 2 + 16 || r.height < pad * 2 + 16) return;
    this.scale = Math.max(0.02, Math.min((r.width - pad * 2) / this.w, (r.height - pad * 2) / this.h, 4));
    this.tx = (r.width - this.w * this.scale) / 2; this.ty = (r.height - this.h * this.scale) / 2;
    this.applyTransform();
  }
  zoomAt(f, cx, cy) {
    this.autoFit = false;
    const ns = Math.max(0.02, Math.min(16, this.scale * f));
    this.tx = cx - (cx - this.tx) * (ns / this.scale); this.ty = cy - (cy - this.ty) * (ns / this.scale); this.scale = ns;
    this.applyTransform();
  }
  zoomTo(s) { const r = this.viewport.getBoundingClientRect(); this.zoomAt(s / this.scale, r.width / 2, r.height / 2); }
  applyTransform() {
    this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.stage.classList.toggle('pixelated', this.scale >= 2);
    this.onZoom?.(this.scale);
    this.drawCursor();
  }
  setView(v) { this.view = v; this.updateLayers(); }
  updateLayers() {
    const v = this.holdOriginal ? 'original' : this.view;
    this.glCanvas.style.visibility = v === 'result' ? 'visible' : 'hidden';
    this.orig.style.visibility = v === 'result' ? 'hidden' : 'visible';
    this.overlay.style.visibility = v === 'parts' ? 'visible' : 'hidden';
    this.overlay.style.opacity = 1;
  }
  toImage(clientX, clientY) {
    const r = this.viewport.getBoundingClientRect();
    return [(clientX - r.left - this.tx) / this.scale, (clientY - r.top - this.ty) / this.scale];
  }

  // ---------- overlay ----------
  drawOverlay(x0 = 0, y0 = 0, x1 = this.w, y1 = this.h) {
    const E = this.getState(); if (!E) return;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(this.w, Math.ceil(x1)); y1 = Math.min(this.h, Math.ceil(y1));
    const bw = x1 - x0, bh = y1 - y0; if (bw <= 0 || bh <= 0) return;
    const img = this.octx.createImageData(bw, bh), d = img.data, m = E.masks, op = this.opacity;
    const cg = PARTS[0].colour, ck = PARTS[1].colour, cs = PARTS[2].colour, ct = PARTS[3].colour;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (y0 + y) * this.w + x0 + x, j = (y * bw + x) * 4;
      const g = m.G[i] / 255, p = m.P[i] / 255 * (1 - g), s = p * m.S[i] / 255, k = p - s, st = g * m.ST[i] / 255, gc = g - st;
      const a = g + p; if (a < 0.004) { d[j + 3] = 0; continue; }
      d[j] = (gc * cg[0] + st * ct[0] + k * ck[0] + s * cs[0]) / a; d[j + 1] = (gc * cg[1] + st * ct[1] + k * ck[1] + s * cs[1]) / a; d[j + 2] = (gc * cg[2] + st * ct[2] + k * ck[2] + s * cs[2]) / a;
      d[j + 3] = 255 * Math.min(1, a) * op;
    }
    this.octx.putImageData(img, x0, y0);
  }

  // ---------- undo ----------
  snapshot() { const m = this.getState().masks; return KEYS.map((k) => Uint8Array.from(m[k])); }
  pushUndo(before, x0, y0, x1, y1, label) {
    const E = this.getState(), w = this.w;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(this.h, Math.ceil(y1));
    const bw = x1 - x0, bh = y1 - y0; if (bw <= 0 || bh <= 0) return;
    const cut = (src) => { const o = new Uint8Array(bw * bh); for (let y = 0; y < bh; y++) o.set(src.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * bw); return o; };
    const entry = { x0, y0, x1, y1, label, before: before.map(cut), after: KEYS.map((k) => cut(E.masks[k])) };
    this.undoStack.push(entry); if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    this.onHistory?.();
  }
  restore(entry, which) {
    const E = this.getState(), w = this.w, bw = entry.x1 - entry.x0;
    KEYS.forEach((k, q) => { const src = entry[which][q]; for (let y = entry.y0; y < entry.y1; y++) E.masks[k].set(src.subarray((y - entry.y0) * bw, (y - entry.y0 + 1) * bw), y * w + entry.x0); });
    this.drawOverlay(entry.x0, entry.y0, entry.x1, entry.y1);
    this.onCommit?.({ x0: entry.x0, y0: entry.y0, x1: entry.x1, y1: entry.y1 });
  }
  undo() { const e = this.undoStack.pop(); if (!e) return; this.restore(e, 'before'); this.redoStack.push(e); this.smart = null; this.onHistory?.(); }
  redo() { const e = this.redoStack.pop(); if (!e) return; this.restore(e, 'after'); this.undoStack.push(e); this.onHistory?.(); }

  // replace all masks at once (auto-split, clear), undoable
  setMasks(next, label) {
    const before = this.snapshot(), E = this.getState();
    for (const k of KEYS) if (next[k]) E.masks[k].set(next[k]);
    this.pushUndo(before, 0, 0, this.w, this.h, label);
    this.drawOverlay(); this.onCommit?.({ x0: 0, y0: 0, x1: this.w, y1: this.h });
  }

  // ---------- painting ----------
  dab(cx, cy, box) {
    const E = this.getState(), m = E.masks, r = this.size / 2, hard = 1 - this.soft, w = this.w;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r; if (dd >= 1) continue;
      const a = dd <= hard ? 1 : 1 - (dd - hard) / Math.max(1e-6, 1 - hard);
      applyAt(m, y * w + x, a * a * (3 - 2 * a), this.part, this.erase);
    }
    box.x0 = Math.min(box.x0, x0); box.y0 = Math.min(box.y0, y0); box.x1 = Math.max(box.x1, x1 + 1); box.y1 = Math.max(box.y1, y1 + 1);
  }
  strokeTo(x, y) {
    const p = this.pointer, step = Math.max(1, this.size / 6), dx = x - p.lx, dy = y - p.ly, dist = Math.hypot(dx, dy);
    const nb = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
    for (let t = step; t <= dist; t += step) this.dab(p.lx + (dx * t) / dist, p.ly + (dy * t) / dist, nb);
    if (dist >= step) { p.lx = x; p.ly = y; }
    if (nb.x1 >= 0) { this.mergeBox(p.box, nb); this.drawOverlay(nb.x0, nb.y0, nb.x1, nb.y1); this.onLive?.(nb); }
  }
  mergeBox(a, b) { a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); }
  // the masks a stroke of the current part changes
  changedKeys(erase) {
    const p = this.part;
    if (!erase) return { gear: ['G'], kit: ['P', 'G'], skin: ['P', 'S', 'G'], steel: ['G', 'ST'], place: ['G', 'P'] }[p];
    return { gear: ['G'], kit: ['P'], skin: ['S'], steel: ['ST'], place: [] }[p];
  }
  // snap what a stroke changed to the photo's edges (guided filter on the changed rectangle only)
  snapBox(box, erase) {
    if (!this.snap) return;
    const E = this.getState(), w = this.w, r = Math.max(2, Math.round(Math.max(this.w, this.h) / 500));
    const x0 = Math.max(0, box.x0 - 3 * r), y0 = Math.max(0, box.y0 - 3 * r), x1 = Math.min(w, box.x1 + 3 * r), y1 = Math.min(this.h, box.y1 + 3 * r);
    const sw = x1 - x0, sh = y1 - y0; if (sw < 4 || sh < 4) return;
    const I = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) I[y * sw + x] = E.Ly[(y0 + y) * w + x0 + x];
    for (const k of this.changedKeys(erase)) {
      const src = E.masks[k], p = new Float32Array(sw * sh);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) p[y * sw + x] = src[(y0 + y) * w + x0 + x] / 255;
      const q = guided(I, p, sw, sh, r, 2e-3);
      for (let y = r; y < sh - r; y++) for (let x = r; x < sw - r; x++) src[(y0 + y) * w + x0 + x] = Math.round(q[y * sw + x] * 255);
    }
  }
  fillPolygon(pts) {
    const E = this.getState(); if (pts.length < 3) return null;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.max(0, Math.floor(x0) - 2); y0 = Math.max(0, Math.floor(y0) - 2); x1 = Math.min(this.w, Math.ceil(x1) + 2); y1 = Math.min(this.h, Math.ceil(y1) + 2);
    const bw = x1 - x0, bh = y1 - y0; if (bw < 2 || bh < 2) return null;
    const c = document.createElement('canvas'); c.width = bw; c.height = bh; const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x - x0, y - y0) : g.moveTo(x - x0, y - y0))); g.closePath(); g.fill();
    const d = g.getImageData(0, 0, bw, bh).data, m = E.masks;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const a = d[(y * bw + x) * 4] / 255; if (a > 0) applyAt(m, (y0 + y) * this.w + x0 + x, a, this.part, this.erase); }
    return { x0, y0, x1, y1 };
  }
  // apply a whole-image soft mask (from click-to-select) as the current part
  applyMask(mask, erase) {
    const E = this.getState(), m = E.masks; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < E.n; i++) { const a = mask[i]; if (a > 0.002) { applyAt(m, i, a, this.part, erase); const x = i % this.w, y = (i / this.w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    return x1 >= 0 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null;
  }

  // ---------- pointer ----------
  bind() {
    const vp = this.viewport;
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else if (e.altKey) this.zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
      else { this.autoFit = false; this.tx -= e.deltaX; this.ty -= e.deltaY; this.applyTransform(); }
    }, { passive: false });
    vp.addEventListener('pointerdown', (e) => this.down(e));
    vp.addEventListener('pointermove', (e) => this.move(e));
    vp.addEventListener('pointerup', (e) => this.up(e));
    vp.addEventListener('pointercancel', (e) => this.up(e));
    vp.addEventListener('pointerleave', () => { this.hover = null; this.drawCursor(); });
    vp.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => {
      const r = vp.getBoundingClientRect();
      this.ui.width = Math.round(r.width * devicePixelRatio); this.ui.height = Math.round(r.height * devicePixelRatio);
      this.ui.style.width = r.width + 'px'; this.ui.style.height = r.height + 'px';
      if (this.autoFit) this.fit(); else this.drawCursor();
    }).observe(vp);
  }
  panning(e) { return this.spaceDown || e.button === 1 || e.button === 2 || this.tool === 'hand'; }
  async down(e) {
    if (!this.getState()) return;
    this.viewport.setPointerCapture(e.pointerId);
    const [x, y] = this.toImage(e.clientX, e.clientY);
    if (this.panning(e)) { this.pointer = { mode: 'pan', sx: e.clientX, sy: e.clientY, tx: this.tx, ty: this.ty }; this.viewport.classList.add('grabbing'); return; }
    if (this.picking) { this.picking = false; this.viewport.classList.remove('picking'); this.onPick?.(Math.round(x), Math.round(y)); return; }
    if (e.button !== 0) return;
    const erase = this.erase || e.altKey;
    if (this.tool === 'brush') {
      const savedErase = this.erase; this.erase = erase;
      this.pointer = { mode: 'brush', before: this.snapshot(), lx: x, ly: y, box: { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }, savedErase, erasing: erase };
      const nb = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }; this.dab(x, y, nb); this.mergeBox(this.pointer.box, nb);
      this.drawOverlay(nb.x0, nb.y0, nb.x1, nb.y1); this.onLive?.(nb);
    } else if (this.tool === 'lasso') {
      this.pointer = { mode: 'lasso', pts: [[x, y]], erase };
    } else if (this.tool === 'click') {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const label = e.altKey ? 0 : 1;
      const extend = e.shiftKey && this.smart && this.smart.undoLen === this.undoStack.length;
      if (extend) { this.undo(); this.redoStack.pop(); this.smart.points.push([x, y]); this.smart.labels.push(label); }
      else this.smart = { points: [[x, y]], labels: [1], erase: e.altKey };
      this.onStatus?.('Selecting…');
      try {
        const mask = await this.onSmart?.(this.smart.points, this.smart.labels);
        if (!mask) return;
        const before = this.snapshot(), box = this.applyMask(mask, this.smart.erase);
        if (box) { this.pushUndo(before, box.x0, box.y0, box.x1, box.y1, 'Click to select'); this.drawOverlay(box.x0, box.y0, box.x1, box.y1); this.onCommit?.(box); }
        this.smart.undoLen = this.undoStack.length;
        this.onStatus?.(this.smart.erase ? 'Removed from ' + this.partLabel() + '. Shift-click to refine.' : 'Added to ' + this.partLabel() + '. Shift-click to add more of it, Alt-click elsewhere to start a removal.');
      } catch (err) { console.error(err); this.onStatus?.('Click to select could not run: ' + (err.message || err)); }
    }
  }
  move(e) {
    const [x, y] = this.toImage(e.clientX, e.clientY);
    this.hover = [e.clientX, e.clientY];
    const p = this.pointer;
    if (p && p.mode === 'pan') { this.autoFit = false; this.tx = p.tx + e.clientX - p.sx; this.ty = p.ty + e.clientY - p.sy; this.applyTransform(); return; }
    if (p && p.mode === 'brush') this.strokeTo(x, y);
    else if (p && p.mode === 'lasso') { const last = p.pts[p.pts.length - 1]; if (Math.hypot(x - last[0], y - last[1]) * this.scale > 3) p.pts.push([x, y]); }
    this.drawCursor();
  }
  up(e) {
    const p = this.pointer; this.pointer = null; this.viewport.classList.remove('grabbing');
    if (!p) return;
    if (p.mode === 'brush') {
      this.erase = p.savedErase;
      if (p.box.x1 >= 0) {
        this.snapBox(p.box, p.erasing);
        this.pushUndo(p.before, p.box.x0 - 8, p.box.y0 - 8, p.box.x1 + 8, p.box.y1 + 8, 'Brush');
        this.drawOverlay(p.box.x0 - 8, p.box.y0 - 8, p.box.x1 + 8, p.box.y1 + 8);
        this.onCommit?.(p.box);
      }
    } else if (p.mode === 'lasso') {
      const before = this.snapshot(), saved = this.erase; this.erase = p.erase;
      const box = this.fillPolygon(p.pts); this.erase = saved;
      if (box) { this.snapBox(box, p.erase); this.pushUndo(before, box.x0 - 8, box.y0 - 8, box.x1 + 8, box.y1 + 8, 'Lasso'); this.drawOverlay(box.x0 - 8, box.y0 - 8, box.x1 + 8, box.y1 + 8); this.onCommit?.(box); }
    }
    this.drawCursor();
  }
  partLabel() { return PARTS.find((q) => q.id === this.part).label; }

  drawCursor() {
    const g = this.uctx, dpr = devicePixelRatio; if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.ui.width, this.ui.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = this.viewport.getBoundingClientRect();
    const p = this.pointer;
    if (p && p.mode === 'lasso' && p.pts.length > 1) {
      g.beginPath(); p.pts.forEach(([x, y], i) => { const sx = x * this.scale + this.tx, sy = y * this.scale + this.ty; i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
      g.closePath(); g.lineWidth = 3; g.strokeStyle = 'rgba(250,248,243,.9)'; g.stroke(); g.lineWidth = 1.5; g.setLineDash([6, 4]); g.strokeStyle = '#1F1B16'; g.stroke(); g.setLineDash([]);
      g.fillStyle = 'rgba(170,54,17,.12)'; g.fill();
    }
    if (this.hover && this.tool === 'brush' && !this.spaceDown && !this.picking) {
      const sx = this.hover[0] - r.left, sy = this.hover[1] - r.top, rad = (this.size / 2) * this.scale;
      g.beginPath(); g.arc(sx, sy, Math.max(2, rad), 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = 'rgba(250,248,243,.85)'; g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = this.erase ? '#5A5148' : '#1F1B16'; if (this.erase) g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
      if (this.soft > 0.05) { g.beginPath(); g.arc(sx, sy, Math.max(1, rad * (1 - this.soft)), 0, Math.PI * 2); g.lineWidth = 1; g.strokeStyle = 'rgba(31,27,22,.45)'; g.stroke(); }
    }
  }
}

// a soft version of a hard mask, for click-to-select results: feathered a little and snapped to the photo
export const softenMask = (E, m) => {
  const r = Math.max(1, Math.round(Math.max(E.w, E.h) / 900));
  const b = boxMean(m, E.w, E.h, r);
  const out = new Float32Array(E.n); for (let i = 0; i < E.n; i++) out[i] = b[i];
  guidedRect(E.Ly, out, E.w, E.h, 0, 0, E.w, E.h, Math.max(2, r * 2), 1e-3);
  return out;
};
