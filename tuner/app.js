// Tuned by part: the app. Wires the engine (engine.js, gl.js), the editor (editor.js) and the split (segment.js)
// to the page. Everything runs in this browser; photos never leave the machine.
import { defaultParams, STRENGTHS, STRENGTH_LABELS, PART_KEYS, MIXES, applyMix, matchMix, createState, computeGains, computeLab, ensureNoise, computeDecon, computeStats, makeUniforms, renderCPU } from './engine.js';
import { GLRenderer } from './gl.js';
import { Editor, PARTS, softenMask } from './editor.js';
import { autoSplit, SmartSelect, pickDevice, skinWithin } from '../shared/segment.js';
import { drawScaled, toU8, toF32 } from '../shared/imgproc.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- settings kept between visits ----------
const LS_PARAMS = 'ea-tuner-params-v1', LS_PRESETS = 'ea-tuner-presets-v1', LS_UI = 'ea-tuner-ui-v1';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => { if (!isObj(over)) return base; for (const k of Object.keys(over)) { if (isObj(over[k]) && isObj(base[k])) merge(base[k], over[k]); else if (over[k] !== undefined && k in base) base[k] = over[k]; } return base; };
const clone = (o) => JSON.parse(JSON.stringify(o));

const S = {
  E: null, stats: null, params: merge(defaultParams(), store.get(LS_PARAMS, {})),
  src: null, work: null, imageKey: 0, splitting: false, lastSplit: null, pendingGear: null,
  smart: new SmartSelect(), maxWork: 2048,
  exp: merge({ size: 'long', long: 2000, square: 2000, framePct: 70, format: 'jpeg', quality: 0.85, name: '' }, store.get(LS_UI, {}).exp || {}),
};
S.params.wb.pick = null; if (S.params.wb.mode === 'pick') S.params.wb.mode = 'auto';
S.exp.name = '';

// ---------- status line ----------
const statusEl = $('#status');
const status = (msg, kind = '') => { statusEl.textContent = msg; statusEl.className = 'status' + (kind ? ' ' + kind : ''); };
const progress = (p) => { if (p.pct == null) status(p.label + '…', 'busy'); else status(`Downloading ${p.label}: ${p.pct}% of ${p.mb} MB (first time only; your browser keeps it)`, 'busy'); };

// ---------- rendering ----------
const glCanvas = $('#glCanvas');
const gl = new GLRenderer(glCanvas);
let useGL = gl.ok, cpuCtx = useGL ? null : glCanvas.getContext('2d');
if (useGL) S.maxWork = Math.min(S.maxWork, gl.maxSize);
let raf = 0, liveDirty = false, cpuTimer = 0;

const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderNow(); }); };
const renderNow = () => {
  const E = S.E; if (!E) return;
  const U = makeUniforms(S.params, S.stats);
  if (useGL) {
    if (liveDirty) { gl.upload(E, [1]); liveDirty = false; }
    gl.render(U);
  } else {
    clearTimeout(cpuTimer);
    status('Printing…', 'busy');
    cpuTimer = setTimeout(() => { glCanvas.width = E.w; glCanvas.height = E.h; cpuCtx.putImageData(renderCPU(E, U), 0, 0); status('Printed on the CPU (this browser has no WebGL 2, so it is slower).'); }, 120);
  }
  $('#viewport').classList.toggle('transparent', S.params.bg.mode === 'transparent');
  saveParamsSoon();
};

// heavier work when a setting changes the analysis, not just the look
const rebuild = (kind) => {
  const E = S.E; if (!E) return;
  const p = S.params, up = new Set();
  if (kind === 'all' || kind === 'wb') { computeLab(E, computeGains(E, p.wb)); up.add(0); }
  if (kind === 'all' || kind === 'noise') { ensureNoise(E, p.ink.story.grainSize); up.add(0); }
  if (kind === 'all' || kind === 'wb' || kind === 'masks') { computeDecon(E); up.add(2); up.add(3); }
  if (kind === 'all' || kind === 'masks') up.add(1);
  S.stats = computeStats(E, p);
  if (useGL && up.size) { gl.upload(E, [...up]); liveDirty = false; }
  scheduleRender();
};

let saveTimer = 0;
const saveParamsSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { const p = clone(S.params); p.wb.pick = null; if (p.wb.mode === 'pick') p.wb.mode = 'auto'; store.set(LS_PARAMS, p); store.set(LS_UI, { exp: { ...S.exp, name: '' } }); }, 400); };

// ---------- editor ----------
const editor = new Editor({
  viewport: $('#viewport'), stage: $('#stage'), glCanvas, overlay: $('#overlayCanvas'), orig: $('#origCanvas'), ui: $('#uiCanvas'),
  getState: () => S.E,
  onLive: () => { liveDirty = true; if (useGL) scheduleRender(); },
  onCommit: () => rebuild('masks'),
  onSmart: async (points, labels) => {
    await S.smart.setImage(S.work, S.imageKey, progress);
    const { mask } = await S.smart.query(points, labels);
    return softenMask(S.E, mask);
  },
  onStatus: (m) => status(m),
  onPick: (x, y) => { S.params.wb = { ...S.params.wb, mode: 'pick', pick: [x, y] }; syncUI(); rebuild('wb'); status('White balanced on the point you picked. Pick again, or choose Auto.'); },
});
editor.onZoom = (s) => { $('#zoomVal').textContent = Math.round(s * 100) + '%'; };
editor.onHistory = () => { $('#btnUndo').disabled = !editor.undoStack.length; $('#btnRedo').disabled = !editor.redoStack.length; };

// ---------- opening photos ----------
const slug = (name) => (name || 'photo').replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'photo';

const openImage = async (blob, name, { split = $('#chkAutoSplit').checked, gearMask = null } = {}) => {
  try {
    status(`Opening ${name || 'the photo'}…`, 'busy');
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const sw = bmp.width, sh = bmp.height, s = Math.min(1, S.maxWork / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const work = drawScaled(bmp, sw, sh, w, h);
    const rgba = work.getContext('2d').getImageData(0, 0, w, h).data;
    S.src = { bmp, w: sw, h: sh, name: name || 'photo', blob }; S.work = work; S.imageKey++; S.lastSplit = null; S.pendingGear = gearMask;
    S.E = createState(rgba, w, h);
    editor.setImageSize(w, h);
    $('#origCanvas').getContext('2d').drawImage(work, 0, 0);
    document.body.classList.add('has-photo');
    rebuild('all'); editor.drawOverlay(); editor.updateLayers(); editor.onHistory();
    for (const id of ['#btnSplit', '#btnExport', '#btnExport2', '#btnSaveProject', '#btnClearPart', '#btnClearAll']) $(id).disabled = false;
    $('#rowWhole').hidden = true;
    S.exp.name = slug(name);
    $('#exportName').value = S.exp.name;
    $('#esWork').textContent = `This size (${w} × ${h})`;
    $('#splitNote').textContent = 'The split finds the subject, people and the gear. The first time, it downloads about 55 MB of models, which your browser keeps for next time.';
    status(`${S.src.name}: ${sw} × ${sh} px, worked on at ${w} × ${h}.`);
    if (gearMask) applyGearMask(gearMask);
    if (split) await runSplit();
  } catch (e) { console.error(e); status('That file couldn’t be opened as an image.', 'err'); }
};

// a gear mask handed over by the generator (exact product pixels): it replaces the split's gear
const applyGearMask = (gm) => {
  const E = S.E; if (!E || !gm) return;
  const c = document.createElement('canvas'); c.width = gm.w; c.height = gm.h;
  const img = new ImageData(gm.w, gm.h); for (let i = 0; i < gm.w * gm.h; i++) { const v = gm.data[i]; img.data.set([v, v, v, 255], i * 4); }
  c.getContext('2d').putImageData(img, 0, 0);
  const d = drawScaled(c, gm.w, gm.h, E.w, E.h).getContext('2d').getImageData(0, 0, E.w, E.h).data;
  const G = new Uint8Array(E.n), P = Uint8Array.from(E.masks.P);
  for (let i = 0; i < E.n; i++) { G[i] = d[i * 4]; P[i] = Math.round(P[i] * (1 - G[i] / 255)); }
  editor.setMasks({ G, P }, 'The generator’s product');
};

const runSplit = async () => {
  if (!S.E || S.splitting) return;
  S.splitting = true; $('#btnSplit').disabled = true; const key = S.imageKey;
  try {
    const res = await autoSplit(S.E, S.work, { hq: $('#chkHQ').checked, onProgress: progress, smart: S.smart, smartKey: S.imageKey });
    if (key !== S.imageKey) return;
    S.lastSplit = { F: toU8(res.F) };
    editor.setMasks({ G: toU8(res.G), P: toU8(res.P), S: toU8(res.S), ST: new Uint8Array(S.E.n) }, 'Split the photo');
    if (S.pendingGear) applyGearMask(S.pendingGear);
    $('#rowWhole').hidden = false;
    const people = res.boxes.length;
    $('#splitNote').textContent = (people ? res.notes.join(' ') : 'No people found, so the whole subject is the gear. ' + res.notes.join(' ')).trim() + ' Check the Parts view and paint where it’s wrong.';
    status('Split done. Switch to Parts to check it.');
  } catch (e) { console.error(e); status('The split didn’t work here: ' + (e.message || e) + '. You can still paint the parts by hand.', 'err'); }
  finally { S.splitting = false; $('#btnSplit').disabled = !S.E; }
};

// ---------- export ----------
const subjectBox = (E) => {
  let x0 = E.w, y0 = E.h, x1 = -1, y1 = -1;
  for (let y = 0; y < E.h; y++) for (let x = 0; x < E.w; x++) { const i = y * E.w + x; if (E.masks.G[i] > 127 || E.masks.P[i] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
};

const renderForExport = async () => {
  const E = S.E, src = S.src, o = S.exp, ws = E.w / src.w; // working pixels per source pixel
  let ow, oh, s, ox = 0, oy = 0;
  if (o.size === 'work') { ow = E.w; oh = E.h; s = ws; }
  else if (o.size === 'long') { const L = Math.max(200, Math.min(6000, +o.long || 2000)); s = L / Math.max(src.w, src.h); ow = Math.round(src.w * s); oh = Math.round(src.h * s); }
  else if (o.size === 'square') { const Q = Math.max(200, Math.min(6000, +o.square || 2000)); s = Q / Math.max(src.w, src.h); ow = oh = Q; ox = (Q - src.w * s) / 2; oy = (Q - src.h * s) / 2; }
  else { // frame the subject at a share of the square's height
    const Q = Math.max(200, Math.min(6000, +o.square || 2000)), b = subjectBox(E);
    if (!b) throw new Error('There are no parts yet to frame. Split the photo first, or choose another size.');
    const bw = (b.x1 - b.x0) / ws, bh = (b.y1 - b.y0) / ws, cx = (b.x0 + b.x1) / 2 / ws, cy = (b.y0 + b.y1) / 2 / ws;
    s = Math.min((Q * (+o.framePct || 70)) / 100 / bh, (Q * 0.92) / bw);
    ow = oh = Q; ox = Q / 2 - cx * s; oy = Q / 2 - cy * s;
  }
  if (ow * oh > 36e6) throw new Error('That size is too large to print here (over 36 megapixels).');
  // the photo, resampled from the original file
  const c = document.createElement('canvas'); c.width = ow; c.height = oh;
  const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, ow, oh);
  const dw = Math.round(src.w * s), dh = Math.round(src.h * s);
  if (dw === src.w && dh === src.h) g.drawImage(src.bmp, Math.round(ox), Math.round(oy));
  else g.drawImage(drawScaled(src.bmp, src.w, src.h, Math.max(1, dw), Math.max(1, dh)), Math.round(ox), Math.round(oy));
  const rgba = g.getImageData(0, 0, ow, oh).data;
  const E2 = createState(rgba, ow, oh);
  // the parts, resampled from the working masks; outside the photo is the place
  const k = s / ws;
  for (const key of ['G', 'P', 'S', 'ST']) {
    const mc = document.createElement('canvas'); mc.width = E.w; mc.height = E.h;
    const mi = new ImageData(E.w, E.h), m = E.masks[key];
    for (let i = 0; i < E.n; i++) { const v = m[i]; mi.data[i * 4] = v; mi.data[i * 4 + 1] = v; mi.data[i * 4 + 2] = v; mi.data[i * 4 + 3] = 255; }
    mc.getContext('2d').putImageData(mi, 0, 0);
    const oc = document.createElement('canvas'); oc.width = ow; oc.height = oh;
    const og = oc.getContext('2d', { willReadFrequently: true }); og.imageSmoothingQuality = 'high';
    og.drawImage(mc, Math.round(ox), Math.round(oy), Math.round(E.w * k), Math.round(E.h * k));
    const od = og.getImageData(0, 0, ow, oh).data, t = E2.masks[key];
    for (let i = 0; i < E2.n; i++) t[i] = od[i * 4];
  }
  computeLab(E2, E.gains); E2.lin = null;
  ensureNoise(E2, S.params.ink.story.grainSize);
  computeDecon(E2);
  const U = makeUniforms(S.params, S.stats);
  let img;
  const r2 = new GLRenderer(document.createElement('canvas'));
  if (r2.ok && r2.fits(ow, oh)) { r2.upload(E2); r2.render(U); img = r2.read(); r2.dispose(); }
  else { r2.dispose(); img = renderCPU(E2, U); }
  const out = document.createElement('canvas'); out.width = ow; out.height = oh;
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
};

const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); };

const exportImage = async () => {
  if (!S.E) return;
  status('Printing at full size…', 'busy');
  await new Promise((r) => setTimeout(r, 30));
  try {
    let fmt = S.exp.format;
    if (S.params.bg.mode === 'transparent' && fmt !== 'png') fmt = 'png';
    const canvas = await renderForExport();
    const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt];
    const blob = await new Promise((res) => canvas.toBlob(res, type, S.exp.quality));
    if (!blob) throw new Error('the browser could not encode the image');
    const name = (slug($('#exportName').value || S.exp.name) || 'photo') + '.' + (fmt === 'jpeg' ? 'jpg' : fmt);
    download(blob, name);
    status(`Saved ${name}: ${canvas.width} × ${canvas.height} px${fmt !== S.exp.format ? ' (PNG, to keep the transparency)' : ''}.`);
  } catch (e) { console.error(e); status('Couldn’t save the image: ' + (e.message || e), 'err'); }
};

// ---------- projects ----------
const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
const maskToPNG = (E, u8) => { const c = document.createElement('canvas'); c.width = E.w; c.height = E.h; const img = new ImageData(E.w, E.h); for (let i = 0; i < E.n; i++) { const v = u8[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; } c.getContext('2d').putImageData(img, 0, 0); return c.toDataURL('image/png'); };
const loadImg = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });

const saveProject = async () => {
  const E = S.E; if (!E) return;
  status('Saving the project…', 'busy');
  const proj = {
    app: 'ea-tuned-by-part', version: 1, saved: new Date().toISOString(), name: S.src.name,
    image: await blobToDataURL(S.src.blob), work: [E.w, E.h],
    masks: { G: maskToPNG(E, E.masks.G), P: maskToPNG(E, E.masks.P), S: maskToPNG(E, E.masks.S), ST: maskToPNG(E, E.masks.ST) },
    params: S.params, export: { ...S.exp, name: $('#exportName').value || S.exp.name },
  };
  download(new Blob([JSON.stringify(proj)], { type: 'application/json' }), slug($('#exportName').value || S.src.name) + '.tuned.json');
  status('Project saved. Open it here later to carry on where you left off.');
};

const openProject = async (file) => {
  try {
    status('Opening the project…', 'busy');
    const proj = JSON.parse(await file.text());
    if (proj.app !== 'ea-tuned-by-part') throw new Error('this isn’t a Tuned by part project');
    const blob = await (await fetch(proj.image)).blob();
    S.params = merge(defaultParams(), proj.params || {});
    S.exp = merge(S.exp, proj.export || {});
    await openImage(blob, proj.name, { split: false });
    const E = S.E;
    for (const key of ['G', 'P', 'S', 'ST']) {
      if (!proj.masks?.[key]) continue;
      const im = await loadImg(proj.masks[key]);
      const d = drawScaled(im, im.naturalWidth, im.naturalHeight, E.w, E.h).getContext('2d').getImageData(0, 0, E.w, E.h).data;
      for (let i = 0; i < E.n; i++) E.masks[key][i] = d[i * 4];
    }
    editor.undoStack = []; editor.redoStack = []; editor.onHistory();
    $('#exportName').value = S.exp.name || slug(proj.name);
    syncUI(); rebuild('all'); editor.drawOverlay();
    status(`Opened ${file.name}.`);
  } catch (e) { console.error(e); status('Couldn’t open the project: ' + (e.message || e), 'err'); }
};

// ---------- the panel ----------
const PART_INFO = {
  place: { label: 'The place behind', colour: '#CFC6B6' },
  gear: { label: 'The gear for sale', colour: '#AA3611' },
  kit: { label: 'The kit worn', colour: '#345CC4' },
  skin: { label: 'Skin', colour: '#ECB234' },
};
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
const setPath = (obj, path, v) => { const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((a, k) => a[k], obj); o[last] = v; };
const fmt = (path, v) => {
  if (path.endsWith('Pct')) return (+v).toFixed(1);
  if (path === 'ink.story.grainSize') return (+v).toFixed(2) + ' px';
  if (path === 'wb.strength' || path === 'bg.shadows') return Math.round(v * 100) + '%';
  return (+v).toFixed(2);
};
const rebuildKindFor = (path) => {
  if (path === 'ink.story.grainSize') return 'noise';
  if (path.startsWith('wb.')) return 'wb';
  if (path.startsWith('ink.colours') || path.startsWith('bg.')) return 'render';
  return 'stats';
};

const seg = (el, items, current, onPick) => {
  el.innerHTML = '';
  for (const [v, label, title] of items) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.v = v; b.textContent = label; if (title) b.title = title;
    b.setAttribute('aria-pressed', String(v === current)); b.addEventListener('click', () => onPick(v)); el.appendChild(b);
  }
};
const pressSeg = (el, v) => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));

// parts to paint
seg($('#segPart'), PARTS.map((p) => [p.id, p.label, `${p.hint} (${p.key})`]), editor.part, (v) => setPart(v));
$$('#segPart button').forEach((b, i) => { const c = PARTS[i].colour; if (c) b.style.boxShadow = `inset 4px 0 0 rgb(${c.join(',')})`; });
const setPart = (v) => { editor.part = v; pressSeg($('#segPart'), v); $('#partHint').textContent = PARTS.find((p) => p.id === v).hint + '.'; };
setPart('gear');
const TOOL_HINTS = {
  brush: 'Paint the part. Hold Alt to erase. Snap keeps the stroke on the photo’s edges.',
  lasso: 'Draw round an area to fill it with the part. Hold Alt to remove.',
  click: 'Click an object to add it to the part. Shift-click to add more of it; Alt-click to take an object out.',
  hand: 'Drag to move the photo. Pinch or Ctrl-scroll to zoom.',
};
const setTool = (v) => {
  editor.tool = v; pressSeg($('#segTool'), v);
  const vp = $('#viewport'); for (const t of ['brush', 'lasso', 'click', 'hand']) vp.classList.toggle('tool-' + t, t === v);
  $('#rowBrush').hidden = v !== 'brush'; $('#toolHint').textContent = TOOL_HINTS[v];
  if (v !== 'hand' && editor.view === 'result' && S.E) setView('parts');
  editor.drawCursor();
};
$$('#segTool button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.v)));
const setView = (v) => { editor.setView(v); pressSeg($('#segView'), v); };
$$('#segView button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));

const bindRange = (id, outId, fmtFn, onInput) => { const el = $(id), out = $(outId); const f = () => { out.textContent = fmtFn(+el.value); onInput(+el.value); }; el.addEventListener('input', f); f(); };
bindRange('#brushSize', '#brushSizeV', (v) => v + ' px', (v) => { editor.size = v; editor.drawCursor(); });
bindRange('#brushSoft', '#brushSoftV', (v) => v + '%', (v) => { editor.soft = v / 100; editor.drawCursor(); });
bindRange('#overlayOp', '#overlayOpV', (v) => v + '%', (v) => { editor.opacity = v / 100; if (S.E) editor.drawOverlay(); });
$('#chkErase').addEventListener('change', (e) => { editor.erase = e.target.checked; editor.drawCursor(); });
$('#chkSnap').addEventListener('change', (e) => { editor.snap = e.target.checked; });
$('#btnUndo').addEventListener('click', () => editor.undo());
$('#btnRedo').addEventListener('click', () => editor.redo());
$('#btnClearPart').addEventListener('click', () => {
  const E = S.E; if (!E) return; const z = new Uint8Array(E.n), m = E.masks, part = editor.part;
  if (part === 'gear') editor.setMasks({ G: z, ST: z }, 'Clear gear');
  else if (part === 'kit') editor.setMasks({ P: Uint8Array.from(m.P, (v, i) => Math.round(v * m.S[i] / 255)) }, 'Clear kit');
  else if (part === 'skin') editor.setMasks({ S: z }, 'Clear skin');
  else if (part === 'steel') editor.setMasks({ ST: z }, 'Clear steel');
  else editor.setMasks({ G: Uint8Array.from(m.G), P: Uint8Array.from(m.P) }, 'Nothing to clear');
});
$('#btnClearAll').addEventListener('click', () => { const E = S.E; if (!E) return; const z = () => new Uint8Array(E.n); editor.setMasks({ G: z(), P: z(), S: z(), ST: z() }, 'Clear all parts'); });
$$('[data-whole]').forEach((b) => b.addEventListener('click', () => {
  const E = S.E, F = S.lastSplit?.F; if (!E || !F) return; const z = new Uint8Array(E.n);
  if (b.dataset.whole === 'gear') editor.setMasks({ G: Uint8Array.from(F), P: z, S: z, ST: z }, 'The whole subject as gear');
  else editor.setMasks({ G: z, P: Uint8Array.from(F), S: toU8(skinWithin(E, toF32(F))), ST: z }, 'The whole subject as kit');
}));
$('#btnSplit').addEventListener('click', () => runSplit());

// colour by part
seg($('#segMix'), MIXES.map((m) => [m.id, m.label, m.note]), matchMix(S.params), (id) => {
  applyMix(S.params, MIXES.find((m) => m.id === id)); syncUI(); scheduleRender();
});
const partsColour = $('#partsColour');
for (const key of PART_KEYS) {
  const info = PART_INFO[key], wrap = document.createElement('div'); wrap.className = 'partc'; wrap.dataset.part = key;
  wrap.innerHTML = `<div class="phead"><span class="sw" style="background:${info.colour}"></span><span class="lab">${info.label}</span><button type="button" class="mini" aria-expanded="false">Fine-tune</button></div>
    <div class="seg" role="group" aria-label="${info.label}"></div>
    <div class="adv" hidden>
      <label class="sl"><span class="lab">Colour kept</span><input type="range" data-f="k" min="0" max="1" step="0.01"><output></output></label>
      <label class="sl"><span class="lab">Cool colours kept</span><input type="range" data-f="cool" min="0" max="1" step="0.01"><output></output></label>
      <label class="sl"><span class="lab">Strongest colours rolled off at</span><input type="range" data-f="knee" min="0" max="80" step="1"><output></output></label>
    </div>
    ${key === 'place' ? '<label class="sl"><span class="lab">Lift toward the paper</span><input type="range" data-fade min="0" max="1" step="0.01"><output></output></label>' : ''}`;
  partsColour.appendChild(wrap);
  seg(wrap.querySelector('.seg'), STRENGTH_LABELS, S.params.parts[key].preset, (v) => { S.params.parts[key] = { preset: v, ...STRENGTHS[v] }; syncUI(); scheduleRender(); });
  const mini = wrap.querySelector('.mini'), adv = wrap.querySelector('.adv');
  mini.addEventListener('click', () => { adv.hidden = !adv.hidden; mini.setAttribute('aria-expanded', String(!adv.hidden)); });
  wrap.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('input', () => {
    const p = S.params.parts[key]; p[inp.dataset.f] = +inp.value; p.preset = 'custom'; syncUI(); scheduleRender();
  }));
  const fade = wrap.querySelector('[data-fade]');
  if (fade) fade.addEventListener('input', () => { S.params.fade = +fade.value; syncUI(); scheduleRender(); });
}

// ink, white balance, background: inputs bound by their data-p path
$$('[data-p]').forEach((el) => {
  const path = el.dataset.p, ev = el.type === 'checkbox' || el.type === 'color' ? 'input' : 'input';
  el.addEventListener(ev, () => {
    const v = el.type === 'checkbox' ? el.checked : el.type === 'color' ? el.value.toUpperCase() : +el.value;
    setPath(S.params, path, v);
    const out = el.parentElement.querySelector('output'); if (out) out.textContent = fmt(path, v);
    const kind = rebuildKindFor(path);
    if (kind === 'render') scheduleRender(); else rebuild(kind);
  });
});
$$('#segInk button').forEach((b) => b.addEventListener('click', () => { S.params.ink.type = b.dataset.v; syncUI(); rebuild('stats'); }));
$('#btnInkReset').addEventListener('click', () => { S.params.ink.colours = clone(defaultParams().ink.colours); syncUI(); scheduleRender(); });
$$('#segWB button').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.v;
  if (v === 'pick') { if (!S.E) return; editor.picking = true; $('#viewport').classList.add('picking'); status('Click something neutral in the photo: a grey card, a white sleeve, a wall.'); pressSeg($('#segWB'), 'pick'); return; }
  S.params.wb.mode = v; S.params.wb.pick = null; editor.picking = false; $('#viewport').classList.remove('picking'); syncUI(); rebuild('wb');
}));
const FILLS = [['#E6DFCF', 'Paper'], ['#FAF8F3', 'Substrate'], ['#D7CAB3', 'Toned'], ['#FFFFFF', 'White']];
const fillSw = $('#fillSwatches');
for (const [hex, name] of FILLS) { const b = document.createElement('button'); b.type = 'button'; b.style.background = hex; b.title = `${name} ${hex}`; b.setAttribute('aria-label', name); b.dataset.hex = hex; b.addEventListener('click', () => { S.params.bg.fill = hex; syncUI(); scheduleRender(); }); fillSw.appendChild(b); }
const customFill = document.createElement('label'); customFill.innerHTML = '<input type="color" id="fillCustom" aria-label="Another colour"> Other';
fillSw.appendChild(customFill);
$('#fillCustom').addEventListener('input', (e) => { S.params.bg.fill = e.target.value.toUpperCase(); syncUI(); scheduleRender(); });
$$('#segBg button').forEach((b) => b.addEventListener('click', () => { S.params.bg.mode = b.dataset.v; syncUI(); scheduleRender(); }));

// presets
const renderPresets = () => {
  const list = store.get(LS_PRESETS, []), ul = $('#presetList'); ul.innerHTML = '';
  if (!list.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'None yet. Saved settings stay in this browser.'; ul.appendChild(li); return; }
  list.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name"></span><button class="btn small" type="button" data-a="use">Use</button><button class="btn small" type="button" data-a="del" aria-label="Delete">Delete</button>`;
    li.querySelector('.name').textContent = p.name;
    li.querySelector('[data-a=use]').addEventListener('click', () => { const keepPick = S.params.wb.pick; S.params = merge(defaultParams(), clone(p.params)); if (S.params.wb.mode === 'pick') { S.params.wb.pick = keepPick; if (!keepPick) S.params.wb.mode = 'auto'; } syncUI(); rebuild('all'); status(`Using “${p.name}”.`); });
    li.querySelector('[data-a=del]').addEventListener('click', () => { const l = store.get(LS_PRESETS, []); l.splice(i, 1); store.set(LS_PRESETS, l); renderPresets(); });
    ul.appendChild(li);
  });
};
$('#btnSavePreset').addEventListener('click', () => { $('#presetName').value = ''; $('#presetDlg').showModal(); });
$('#presetDlg').addEventListener('close', () => {
  if ($('#presetDlg').returnValue !== 'save') return;
  const name = $('#presetName').value.trim(); if (!name) return;
  const p = clone(S.params); p.wb.pick = null; if (p.wb.mode === 'pick') p.wb.mode = 'auto';
  const list = store.get(LS_PRESETS, []).filter((x) => x.name !== name); list.push({ name, params: p }); store.set(LS_PRESETS, list); renderPresets();
});
renderPresets();

// export settings
$$('#exportSize input[type=radio]').forEach((r) => r.addEventListener('change', () => { if (r.checked) { S.exp.size = r.value; saveParamsSoon(); } }));
$('#esLong').addEventListener('input', (e) => { S.exp.long = +e.target.value; $('#exportSize input[value=long]').checked = true; S.exp.size = 'long'; });
$('#esSquare').addEventListener('input', (e) => { S.exp.square = +e.target.value; if (S.exp.size !== 'frame') { $('#exportSize input[value=square]').checked = true; S.exp.size = 'square'; } });
$('#esFramePct').addEventListener('input', (e) => { S.exp.framePct = +e.target.value; $('#exportSize input[value=frame]').checked = true; S.exp.size = 'frame'; });
$$('#segFormat button').forEach((b) => b.addEventListener('click', () => { S.exp.format = b.dataset.v; syncUI(); saveParamsSoon(); }));
bindRange('#exportQ', '#exportQV', (v) => String(v), (v) => { S.exp.quality = v / 100; });
$('#btnExport').addEventListener('click', exportImage);
$('#btnExport2').addEventListener('click', exportImage);
$('#btnSaveProject').addEventListener('click', saveProject);

// reflect the settings in every control
const syncUI = () => {
  const p = S.params;
  pressSeg($('#segMix'), matchMix(p)); const m = MIXES.find((x) => x.id === matchMix(p)); $('#mixHint').textContent = m ? m.note[0].toUpperCase() + m.note.slice(1) + '.' : 'Your own mix.';
  for (const key of PART_KEYS) {
    const wrap = partsColour.querySelector(`[data-part=${key}]`), pp = p.parts[key];
    pressSeg(wrap.querySelector('.seg'), pp.preset);
    wrap.querySelectorAll('[data-f]').forEach((inp) => { const f = inp.dataset.f; inp.value = pp[f]; inp.parentElement.querySelector('output').textContent = f === 'knee' ? (pp.knee > 0 ? String(Math.round(pp.knee)) : 'off') : Math.round(pp[f] * 100) + '%'; });
    const fade = wrap.querySelector('[data-fade]'); if (fade) { fade.value = p.fade; fade.parentElement.querySelector('output').textContent = Math.round(p.fade * 100) + '%'; }
  }
  $$('[data-p]').forEach((el) => {
    const v = getPath(p, el.dataset.p);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    const out = el.parentElement.querySelector('output'); if (out) out.textContent = fmt(el.dataset.p, v);
  });
  pressSeg($('#segInk'), p.ink.type); $('#grpFine').hidden = p.ink.type !== 'fine'; $('#grpStory').hidden = p.ink.type !== 'story';
  pressSeg($('#segWB'), p.wb.mode);
  pressSeg($('#segBg'), p.bg.mode); $('#grpFill').hidden = p.bg.mode !== 'fill';
  $$('#fillSwatches button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hex === p.bg.fill)));
  $('#fillCustom').value = p.bg.fill.length === 7 ? p.bg.fill.toLowerCase() : '#e6dfcf';
  $('#bgHint').textContent = { keep: 'The place prints in the ink, with its own colour setting above.', transparent: 'The place is removed. The edges keep the subject’s own colour and tone, so no fringe of the old background is left. Saves as PNG.', fill: 'The place becomes a flat colour, as on the shop’s product cards (D117).' }[p.bg.mode];
  $$('#exportSize input[type=radio]').forEach((r) => { r.checked = r.value === S.exp.size; });
  $('#esLong').value = S.exp.long; $('#esSquare').value = S.exp.square; $('#esFramePct').value = S.exp.framePct;
  pressSeg($('#segFormat'), S.exp.format); $('#rowQuality').hidden = S.exp.format === 'png';
  $('#exportQ').value = Math.round(S.exp.quality * 100); $('#exportQV').textContent = String(Math.round(S.exp.quality * 100));
};

// ---------- files, drag and drop, paste, samples ----------
const openFile = (f) => { if (!f) return; if (/\.json$/i.test(f.name) || f.type === 'application/json') openProject(f); else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i.test(f.name)) openImage(f, f.name); else status('That file isn’t an image or a project.', 'err'); };
for (const id of ['#fileInput', '#fileInput2']) $(id).addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('#projInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openProject(f); e.target.value = ''; });
window.addEventListener('dragover', (e) => { e.preventDefault(); $('#viewport').classList.add('dragover'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#viewport').classList.remove('dragover'); });
window.addEventListener('drop', (e) => { e.preventDefault(); $('#viewport').classList.remove('dragover'); openFile(e.dataTransfer.files[0]); });
window.addEventListener('paste', (e) => { const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/')); if (item) openImage(item.getAsFile(), 'pasted-photo.png'); });

let samples = null;
const showSamples = async () => {
  const grid = $('#sampleGrid');
  if (!samples) {
    try { samples = await (await fetch('../samples/samples.json')).json(); } catch (e) { samples = []; }
    grid.innerHTML = '';
    for (const s of samples) {
      const b = document.createElement('button'); b.type = 'button';
      b.innerHTML = `<img alt="" loading="lazy"><span class="t"></span><span class="c"></span>`;
      b.querySelector('img').src = '../samples/' + s.file; b.querySelector('.t').textContent = s.title;
      b.querySelector('.c').innerHTML = `${s.creator}, <a href="${s.licenceUrl}" target="_blank" rel="noopener">${s.licence}</a>, <a href="${s.source}" target="_blank" rel="noopener">source</a>`;
      b.addEventListener('click', async (e) => {
        if (e.target.closest('a')) return;
        $('#samplesDlg').close();
        const blob = await (await fetch('../samples/' + s.file)).blob();
        openImage(blob, s.file);
      });
      grid.appendChild(b);
    }
  }
  $('#samplesDlg').showModal();
};
$('#btnSamples').addEventListener('click', showSamples);
$('#btnSamples2').addEventListener('click', showSamples);

// ---------- zoom buttons and keys ----------
$('#zoomIn').addEventListener('click', () => editor.zoomTo(editor.scale * 1.25));
$('#zoomOut').addEventListener('click', () => editor.zoomTo(editor.scale / 1.25));
$('#zoomFit').addEventListener('click', () => editor.fit());
$('#zoom100').addEventListener('click', () => editor.zoomTo(1));
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'radio';
window.addEventListener('keydown', (e) => {
  if (typing(e) || $('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
  if (mod && k.toLowerCase() === 's') { e.preventDefault(); exportImage(); return; }
  if (mod && k === '0') { e.preventDefault(); editor.fit(); return; }
  if (mod) return;
  if (k === ' ') { if (!editor.spaceDown) { editor.spaceDown = true; $('#viewport').classList.add('space'); editor.drawCursor(); } e.preventDefault(); return; }
  if (k === '\\') { if (!editor.holdOriginal) { editor.holdOriginal = true; editor.updateLayers(); } return; }
  const map = { b: 'brush', l: 'lasso', c: 'click', h: 'hand' };
  if (map[k.toLowerCase()]) { setTool(map[k.toLowerCase()]); return; }
  const part = PARTS.find((p) => p.key === k); if (part) { setPart(part.id); return; }
  if (k === '[' || k === ']') { const el = $('#brushSize'); el.value = Math.max(2, Math.min(600, Math.round(+el.value * (k === ']' ? 1.2 : 1 / 1.2)))); el.dispatchEvent(new Event('input')); return; }
  if (k.toLowerCase() === 'x') { const c = $('#chkErase'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); return; }
  if (k.toLowerCase() === 'r') setView('result');
  else if (k.toLowerCase() === 'p') setView('parts');
  else if (k.toLowerCase() === 'o') setView('original');
  else if (k.toLowerCase() === 'f') editor.fit();
  else if (k === '+' || k === '=') editor.zoomTo(editor.scale * 1.25);
  else if (k === '-') editor.zoomTo(editor.scale / 1.25);
  else if (k === 'Escape') { editor.picking = false; $('#viewport').classList.remove('picking'); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { editor.spaceDown = false; $('#viewport').classList.remove('space'); editor.drawCursor(); }
  if (e.key === '\\') { editor.holdOriginal = false; editor.updateLayers(); }
});
window.addEventListener('blur', () => { editor.spaceDown = false; editor.holdOriginal = false; editor.updateLayers(); $('#viewport').classList.remove('space'); });

// ---------- hand-over from the generator (same site, via IndexedDB) ----------
const idbGet = (key) => new Promise((res) => {
  try {
    const rq = indexedDB.open('ea-photo-tools', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('handoff');
    rq.onsuccess = () => { try { const g = rq.result.transaction('handoff', 'readonly').objectStore('handoff').get(key); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); } catch (e) { res(null); } };
    rq.onerror = () => res(null);
  } catch (e) { res(null); }
});

// ---------- start ----------
syncUI(); setTool('brush'); setView('result'); editor.updateLayers();
pickDevice().then((d) => {
  $('#deviceInfo').textContent = `On this machine: the split runs ${d === 'webgpu' ? 'on the graphics card (WebGPU)' : 'on the processor (WebAssembly); WebGPU, where available, is faster'}, and the printing runs ${useGL ? 'on the graphics card (WebGL 2)' : 'on the processor'}.`;
});
if (location.hash.startsWith('#handoff')) {
  idbGet('tuner').then((h) => { if (h && h.blob) openImage(h.blob, h.name || 'generated.png', { gearMask: h.gearMask || null }); });
}
window.__tuner = { S, editor, gl, rebuild, openImage, runSplit, exportImage, renderForExport };
