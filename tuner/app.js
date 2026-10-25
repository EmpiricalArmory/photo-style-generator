// Tuned by part: the app. A batch of photos printed with one set of settings (the ink, the colour by part and the
// background), each photo with its own parts. Wires the engine (engine.js, gl.js, print.js), the editor
// (editor.js), the split (segment.js) and the batch's storage (store.js) to the page. Everything runs in this
// browser; photos never leave it.
import { defaultParams, STRENGTHS, STRENGTH_LABELS, MIXES, applyMix, matchMix, createState, computeLab, ensureNoise, computeDecon, computeAnalysis, computeLevels, statsFrom, wbPickMed, wbAutoMed, gainsFromMed, makeUniforms, renderCPU } from './engine.js';
import { GLRenderer } from './gl.js';
import { Editor, softenMask, paintOverlay } from './editor.js';
import { PARTS, PART } from './parts.js';
import { autoSplit, SmartSelect, skinWithin } from '../shared/segment.js';
import { drawScaled, toU8, toF32 } from '../shared/imgproc.js';
import { renderPrint, maskCanvases } from './print.js';
import { makeZip, readZip } from './zip.js';
import * as store from './store.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
const yieldToPage = () => new Promise((r) => setTimeout(r, 0));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const fitSize = (w, h, max) => { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; };
const slug = (name) => (name || 'photo').replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'photo';
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

// ---------- settings kept between visits ----------
const LS_PARAMS = 'ea-tuner-params-v1', LS_PRESETS = 'ea-tuner-presets-v1', LS_UI = 'ea-tuner-ui-v2';
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => { if (!isObj(over)) return base; for (const k of Object.keys(over)) { if (isObj(over[k]) && isObj(base[k])) merge(base[k], over[k]); else if (over[k] !== undefined && k in base) base[k] = over[k]; } return base; };
const clone = (o) => JSON.parse(JSON.stringify(o));

const ui0 = ls.get(LS_UI, {});
const S = {
  params: merge(defaultParams(), ls.get(LS_PARAMS, {})),
  items: [], cur: null, E: null, stats: null, work: null, lastF: null, imageKey: 0, token: 0,
  smart: new SmartSelect(), queueSmart: new SmartSelect(), queue: [], queueRunning: false, qkey: 0,
  maxWork: 2048, navTarget: null, navTimer: 0,
  view: ui0.view === 'grid' ? 'grid' : 'one',
  show: ['result', 'compare', 'parts', 'original'].includes(ui0.show) ? ui0.show : 'result',
  tile: Math.max(110, Math.min(560, +ui0.tile || 220)),
  panelW: +ui0.panelW || 392,
  autoSplit: ui0.autoSplit !== false,
  exp: { format: ['jpeg', 'png', 'webp'].includes(ui0.exp?.format) ? ui0.exp.format : 'jpeg', quality: Math.max(0.5, Math.min(1, +ui0.exp?.quality || 0.88)) },
};
S.params.wb.pick = null; // a picked grey belongs to its photo now
const saveUI = () => ls.set(LS_UI, { view: S.view, show: S.show, tile: S.tile, panelW: S.panelW, autoSplit: S.autoSplit, exp: S.exp });

// ---------- status line ----------
const statusEl = $('#status');
const status = (msg, kind = '') => { statusEl.textContent = msg; statusEl.className = 'status' + (kind ? ' ' + kind : ''); };
const progress = (p, who = '') => {
  if (p.pct == null) status((who ? who + ': ' : '') + p.label + '…', 'busy');
  else if (!p.mb) status(`Downloading ${p.label}…`, 'busy');
  else status(`Downloading ${p.label}: ${p.pct}% of ${p.mb} MB (first time only; your browser keeps it)`, 'busy');
};
// subject + people + Segment Anything + the ONNX runtime: about 100 MB on the processor, 140 MB on the graphics card
const SPLIT_NOTE = 'The split finds the subject, the people and the product. The first time, it downloads 100 to 140 MB of models, which your browser keeps for next time.';

// ---------- the photo on screen: rendering ----------
const glCanvas = $('#glCanvas');
const gl = new GLRenderer(glCanvas);
let useGL = gl.ok, cpuCtx = useGL ? null : glCanvas.getContext('2d');
if (useGL) S.maxWork = Math.min(S.maxWork, gl.maxSize);
let raf = 0, liveDirty = false, cpuTimer = 0;

let lastKey = '', saveTimer = 0;
const paramsChanged = () => {
  const k = JSON.stringify(S.params); if (k === lastKey) return;
  lastKey = k;
  clearTimeout(saveTimer); saveTimer = setTimeout(() => ls.set(LS_PARAMS, S.params), 400);
  schedulePreviews(250);
};
const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderNow(); }); };
const renderNow = () => {
  const transparent = S.params.bg.mode === 'transparent';
  $('#viewport').classList.toggle('transparent', transparent); $('#grid').classList.toggle('transparent', transparent); $('#film').classList.toggle('transparent', transparent);
  paramsChanged();
  const E = S.E; if (!E) return;
  const U = makeUniforms(S.params, S.stats);
  if (useGL) {
    if (liveDirty) { gl.upload(E, [1]); liveDirty = false; }
    gl.render(U);
  } else {
    clearTimeout(cpuTimer);
    status('Printing…', 'busy');
    cpuTimer = setTimeout(() => { glCanvas.width = E.w; glCanvas.height = E.h; cpuCtx.putImageData(renderCPU(E, U), 0, 0); status('Printed on the processor (this browser has no WebGL 2, so it is slower).'); }, 120);
  }
};

// a photo's white balance: its own picked grey (Pick a grey) or its own near-greys (Auto)
const gainsFor = (it, p = S.params) => {
  if (p.wb.mode === 'off' || !it) return [1, 1, 1];
  return gainsFromMed(p.wb.mode === 'pick' && it.wbPickMed ? it.wbPickMed : it.analysis?.wbAutoMed, p.wb.strength ?? 1);
};

// heavier work when a setting changes the analysis, not just the look
const rebuild = (kind) => {
  const E = S.E, it = S.cur; if (!E || !it) return;
  const p = S.params, up = new Set();
  if (kind === 'all' || kind === 'wb') { computeLab(E, gainsFor(it, p)); up.add(0); }
  if (kind === 'all' || kind === 'noise') { ensureNoise(E, p.ink.story.grainSize); up.add(0); }
  if (kind === 'all' || kind === 'wb' || kind === 'masks') { computeDecon(E); up.add(2); up.add(3); }
  if (kind === 'all' || kind === 'masks') { up.add(1); Object.assign(it.analysis, computeLevels(E)); }
  S.stats = statsFrom(it.analysis, p);
  if (useGL && up.size) { gl.upload(E, [...up]); liveDirty = false; }
  scheduleRender();
};

// ---------- the editor ----------
const editor = new Editor({
  viewport: $('#viewport'), stage: $('#stage'), glCanvas, overlay: $('#overlayCanvas'), orig: $('#origCanvas'), ui: $('#uiCanvas'),
  getState: () => S.E,
  onLive: () => { liveDirty = true; if (useGL) scheduleRender(); },
  onCommit: () => { rebuild('masks'); partsChanged(S.cur); },
  onSmart: async (points, labels) => {
    await S.smart.setImage(S.work, S.imageKey, progress);
    const { mask } = await S.smart.query(points, labels);
    return softenMask(S.E, mask);
  },
  onStatus: (m) => status(m),
  onPick: (x, y) => {
    const it = S.cur; if (!it) return;
    it.wbPick = [x, y]; it.wbPickMed = wbPickMed(S.E, [x, y]); S.params.wb.mode = 'pick';
    syncUI(); rebuild('wb'); persist(it);
    status('White balanced on the point you picked, for this photo. The others use their own pick, or Auto where they have none.');
  },
});
editor.onZoom = (s) => { $('#zoomVal').textContent = Math.round(s * 100) + '%'; };
editor.onHistory = () => { $('#btnUndo').disabled = !editor.undoStack.length; $('#btnRedo').disabled = !editor.redoStack.length; };

// the current photo's parts changed: keep them (packed, after a pause) and refresh its preview
const partsChanged = (it) => {
  if (!it) return;
  it.maskVersion++; it.smallMasks = null; it.overlaySmall = null; it.partsDirty = true;
  clearTimeout(it._ft); it._ft = setTimeout(() => flushParts(it), 1500);
  schedulePreviews(900);
};
const flushParts = async (it) => {
  clearTimeout(it._ft);
  if (!it.partsDirty || it !== S.cur || !S.E) return;
  it.partsDirty = false;
  const p = store.packMasks({ ...S.E.masks, F: S.lastF }, S.E.n); // copies the masks at once
  it.packing = p; it.masksBlob = await p; if (it.packing === p) it.packing = null;
  persist(it);
};

// ---------- the batch: photos ----------
const SMALL = 720; // the previews' long side
const mem = () => ({ small: null, maskVersion: 0, smallMasks: null, overlaySmall: null, preview: null, previewKey: '', undo: [], redo: [], partsDirty: false, packing: null, els: null });
const makeItem = async (blob, name) => {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const srcW = bmp.width, srcH = bmp.height;
  if (srcW * srcH > 80e6) { bmp.close?.(); throw new Error('it’s over 80 megapixels'); }
  const [workW, workH] = fitSize(srcW, srcH, S.maxWork), [smallW, smallH] = fitSize(srcW, srcH, SMALL);
  const small = drawScaled(bmp, srcW, srcH, smallW, smallH); bmp.close?.();
  const smallBlob = await new Promise((r) => small.toBlob(r, 'image/jpeg', 0.9));
  // its levels from the small copy until it's split or opened (then from the working size)
  const Es = createState(ctx2d(small).getImageData(0, 0, smallW, smallH).data, smallW, smallH);
  return {
    id: newId(), name: name || 'photo', blob, type: blob.type || '', srcW, srcH, workW, workH, smallW, smallH, smallBlob,
    outName: slug(name), masksBlob: null, analysis: computeAnalysis(Es), analysisSize: 'small',
    split: { status: 'none', note: '', people: 0 }, wbPick: null, wbPickMed: null, ...mem(), small,
  };
};
const recordOf = (it) => ({
  id: it.id, name: it.name, blob: it.blob, type: it.type, srcW: it.srcW, srcH: it.srcH, workW: it.workW, workH: it.workH,
  smallW: it.smallW, smallH: it.smallH, smallBlob: it.smallBlob, outName: it.outName, masksBlob: it.masksBlob,
  analysis: it.analysis, analysisSize: it.analysisSize, wbPick: it.wbPick, wbPickMed: it.wbPickMed,
  split: { status: it.split.status === 'done' || it.split.status === 'error' ? it.split.status : 'none', note: it.split.note, people: it.split.people },
});
const itemFromRecord = (r) => ({ ...r, split: { ...r.split }, ...mem() });
let storeWarned = false;
const storeFailed = (e) => { console.warn(e); if (!storeWarned) { storeWarned = true; status('This browser couldn’t keep the batch (its storage is full or blocked). Save a project to keep your work.', 'err'); } };
const persist = (it) => { clearTimeout(it._pt); it._pt = setTimeout(() => { if (S.items.includes(it)) store.putItem(recordOf(it)).catch(storeFailed); }, 500); };
const saveOrder = () => store.putMeta('order', S.items.map((i) => i.id)).catch(storeFailed);
const saveCurrent = () => store.putMeta('current', S.cur ? S.cur.id : null).catch(() => {});

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const isImage = (b, name) => (b.type && b.type.startsWith('image/')) || IMG_RE.test(name || '');
const addPhotos = async (list, { gearMask = null, open = true } = {}) => {
  const files = list.filter((f) => f && f.blob && isImage(f.blob, f.name));
  if (!files.length) { if (list.length) status('Those files aren’t photos.', 'err'); return []; }
  const added = [];
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    status(files.length > 1 ? `Adding ${k + 1} of ${files.length}: ${f.name}…` : `Opening ${f.name}…`, 'busy');
    try {
      const it = await makeItem(f.blob, f.name);
      if (gearMask) it.pendingGear = gearMask;
      S.items.push(it); added.push(it); buildItemEls(it); persist(it);
    } catch (e) { console.error(e); status(`${f.name} couldn’t be opened as a photo${e.message ? ' (' + e.message + ')' : ''}.`, 'err'); await new Promise((r) => setTimeout(r, 1200)); }
    await yieldToPage();
  }
  if (!added.length) return added;
  saveOrder(); updateBatchUI();
  if (open || !S.cur) await activate(added[0]);
  if (S.autoSplit) added.forEach((it) => queueSplit(it));
  else status(added.length > 1 ? `Added ${plural(added.length, 'photo')}.` : `${added[0].name}: ${added[0].srcW} × ${added[0].srcH} px.`);
  schedulePreviews();
  return added;
};

// ---------- the batch: the photo on screen ----------
const activate = async (it) => {
  if (!it) return;
  if (S.cur === it) { selectEls(it); return; }
  const token = ++S.token;
  if (S.cur) stash(S.cur);
  S.cur = null; S.E = null; selectEls(it);
  status(`Opening ${it.name}…`, 'busy');
  try {
    if (it.packing) await it.packing;
    const bmp = await createImageBitmap(it.blob, { imageOrientation: 'from-image' });
    if (token !== S.token) { bmp.close?.(); return; }
    const w = it.workW, h = it.workH, work = drawScaled(bmp, bmp.width, bmp.height, w, h); bmp.close?.();
    const E = createState(ctx2d(work).getImageData(0, 0, w, h).data, w, h);
    let F = null;
    if (it.masksBlob) { const m = await store.unpackMasks(it.masksBlob, E.n); for (const k of ['G', 'P', 'S', 'ST']) if (m[k]) E.masks[k].set(m[k]); F = m.F; }
    if (token !== S.token) return;
    it.analysis = computeAnalysis(E, it.analysisSize === 'work' ? it.analysis.wbAutoMed : undefined); it.analysisSize = 'work';
    if (it.wbPick && !it.wbPickMed) it.wbPickMed = wbPickMed(E, it.wbPick);
    S.cur = it; S.E = E; S.work = work; S.lastF = F; S.imageKey++;
    editor.setImageSize(w, h);
    editor.undoStack = it.undo || []; editor.redoStack = it.redo || [];
    $('#origCanvas').getContext('2d').drawImage(work, 0, 0);
    document.body.classList.add('has-photo');
    rebuild('all'); editor.drawOverlay(); editor.updateLayers(); editor.onHistory();
    applyPendingGear(it);
    showPhotoUI(); saveCurrent(); selectEls(it);
    if (!S.queueRunning) status(`${it.name}: ${it.srcW} × ${it.srcH} px${S.items.length > 1 ? ` (${S.items.indexOf(it) + 1} of ${S.items.length})` : ''}.`);
    schedulePreviews(300);
  } catch (e) { console.error(e); if (token === S.token) status(`${it.name} couldn’t be opened: ${e.message || e}`, 'err'); }
};
// the photo being left keeps its parts (packed) and its undo; its full working state is let go
const stash = (it) => {
  it.undo = editor.undoStack; it.redo = editor.redoStack;
  clearTimeout(it._ft);
  if (it.partsDirty && S.E) {
    it.partsDirty = false;
    const p = store.packMasks({ ...S.E.masks, F: S.lastF }, S.E.n);
    it.packing = p; p.then((b) => { it.masksBlob = b; if (it.packing === p) it.packing = null; persist(it); });
  }
  editor.cancelPoly(); editor.picking = false; $('#viewport').classList.remove('picking');
};
const showPhotoUI = () => {
  const it = S.cur, on = !!it;
  for (const id of ['#btnExport', '#btnExport2', '#btnClearPart', '#btnClearAll']) $(id).disabled = !on;
  $('#exportName').value = on ? it.outName : '';
  $('#exportName').disabled = !on;
  $('#saveSize').textContent = on ? `Saved at the photo’s own size: ${it.srcW} × ${it.srcH} px.` : 'Each photo is saved at its own size.';
  showSplitNote(); updateNav();
};
const showSplitNote = () => {
  const it = S.cur, b = $('#btnSplit');
  if (!it) { b.disabled = true; b.textContent = 'Split this photo'; $('#splitNote').textContent = SPLIT_NOTE; $('#rowWhole').hidden = true; return; }
  const st = it.split.status;
  $('#splitNote').textContent = st === 'done' || st === 'error' ? it.split.note : st === 'running' ? 'Splitting this photo…' : st === 'queued' ? 'Waiting to be split, after the photos before it.' : SPLIT_NOTE;
  $('#rowWhole').hidden = !(st === 'done' && S.lastF);
  b.textContent = st === 'none' ? 'Split this photo' : 'Split this photo again';
  b.disabled = st === 'running' || st === 'queued';
};
const clearView = () => {
  S.cur = null; S.E = null; S.work = null; S.lastF = null; S.token++;
  document.body.classList.remove('has-photo');
  editor.undoStack = []; editor.redoStack = []; editor.onHistory(); editor.drawCursor();
  showPhotoUI(); saveCurrent();
};

// ---------- the batch: splitting, one photo at a time ----------
const noteFor = (res) => (res.boxes.length ? res.notes.join(' ') : 'No people found, so the whole subject is the product. ' + res.notes.join(' ')).trim() + ' Check the Parts view and paint where it’s wrong.';
const queueSplit = (it, front = false) => {
  if (it.split.status === 'running' || S.queue.includes(it)) return;
  it.split.status = 'queued'; updateBadge(it); if (it === S.cur) showSplitNote();
  if (front) S.queue.unshift(it); else S.queue.push(it);
  runQueue();
};
const runQueue = async () => {
  if (S.queueRunning) return;
  S.queueRunning = true;
  let n = 0;
  try {
    while (S.queue.length) {
      let i = S.queue.indexOf(S.cur); if (i < 0) i = 0; // the photo on screen first
      const it = S.queue.splice(i, 1)[0];
      if (!S.items.includes(it) || it.split.status !== 'queued') continue;
      await splitItem(it); n++;
      await yieldToPage();
    }
  } finally { S.queueRunning = false; }
  if (!n) return;
  const bad = S.items.filter((i) => i.split.status === 'error').length;
  if (bad) status(`${plural(bad, 'photo')} couldn’t be split: paint ${bad === 1 ? 'it' : 'them'} by hand.`, 'err');
  else status(S.items.length > 1 ? 'Every photo is split. Check them in the Parts view and paint where they’re wrong.' : 'Split done. Switch to Parts to check it.');
};
// the photo at its working size, analysed as far as the split needs
const workingState = async (it) => {
  const bmp = await createImageBitmap(it.blob, { imageOrientation: 'from-image' });
  const work = drawScaled(bmp, bmp.width, bmp.height, it.workW, it.workH); bmp.close?.();
  const E = createState(ctx2d(work).getImageData(0, 0, it.workW, it.workH).data, it.workW, it.workH);
  E.wbMed = wbAutoMed(E);
  const p = S.params;
  computeLab(E, p.wb.mode === 'off' ? [1, 1, 1] : gainsFromMed(p.wb.mode === 'pick' && it.wbPickMed ? it.wbPickMed : E.wbMed, p.wb.strength ?? 1));
  return { E, work };
};
const splitItem = async (it) => {
  it.split.status = 'running'; updateBadge(it); if (it === S.cur) showSplitNote();
  const who = S.items.length > 1 ? it.name : '', onProgress = (p) => progress(p, who);
  try {
    let res, E, work;
    const onScreen = it === S.cur && S.E;
    if (onScreen) { E = S.E; work = S.work; res = await autoSplit(E, work, { onProgress, smart: S.smart, smartKey: S.imageKey }); }
    else { ({ E, work } = await workingState(it)); res = await autoSplit(E, work, { onProgress, smart: S.queueSmart, smartKey: 'q' + (++S.qkey) }); }
    const masks = { G: toU8(res.G), P: toU8(res.P), S: toU8(res.S), ST: new Uint8Array(E.n), F: toU8(res.F) };
    if (it.pendingGear) { mergeGear(masks, it.pendingGear, it.workW, it.workH); delete it.pendingGear; }
    it.split = { status: 'done', note: noteFor(res), people: res.boxes.length };
    if (S.cur === it && S.E) { // on screen now (it may have been opened while it was being split): undoable
      S.lastF = masks.F;
      editor.setMasks({ G: masks.G, P: masks.P, S: masks.S, ST: masks.ST }, 'Split the photo');
    } else {
      for (const k of ['G', 'P', 'S', 'ST']) E.masks[k].set(masks[k]);
      it.analysis = computeAnalysis(E, onScreen ? it.analysis.wbAutoMed : E.wbMed); it.analysisSize = 'work';
      const p = store.packMasks(masks, E.n); it.packing = p; it.masksBlob = await p; if (it.packing === p) it.packing = null;
      it.maskVersion++; it.smallMasks = null; it.overlaySmall = null; it.undo = []; it.redo = [];
      schedulePreviews();
    }
  } catch (e) {
    console.error(e);
    it.split = { status: 'error', note: 'The split didn’t work here: ' + (e.message || e) + '. You can still paint the parts by hand.', people: 0 };
  }
  updateBadge(it); if (it === S.cur) showSplitNote(); persist(it);
};
// a product mask handed over by the scene generator (the exact product pixels) replaces the split's product
const mergeGear = (m, gm, w, h) => {
  const c = canvasOf(gm.w, gm.h), img = new ImageData(gm.w, gm.h);
  for (let i = 0; i < gm.w * gm.h; i++) { const v = gm.data[i]; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  ctx2d(c).putImageData(img, 0, 0);
  const d = ctx2d(drawScaled(c, gm.w, gm.h, w, h)).getImageData(0, 0, w, h).data;
  for (let i = 0; i < w * h; i++) { m.G[i] = d[i * 4]; m.P[i] = Math.round(m.P[i] * (1 - m.G[i] / 255)); }
};
const applyPendingGear = (it) => {
  if (!it.pendingGear || S.autoSplit || it !== S.cur || !S.E) return;
  const m = { G: new Uint8Array(S.E.n), P: Uint8Array.from(S.E.masks.P) };
  mergeGear(m, it.pendingGear, it.workW, it.workH); delete it.pendingGear;
  editor.setMasks({ G: m.G, P: m.P }, 'The generator’s product');
};

// ---------- the batch: previews for the grid and the strip ----------
const needPreviews = () => S.view === 'grid' || S.items.length > 1;
const ensureSmall = (it) => {
  if (it.small) return Promise.resolve(it.small);
  return (it._smallP ||= (async () => {
    try {
      const bmp = await createImageBitmap(it.smallBlob), c = canvasOf(it.smallW, it.smallH);
      ctx2d(c).drawImage(bmp, 0, 0, it.smallW, it.smallH); bmp.close?.();
      return (it.small = c);
    } finally { it._smallP = null; }
  })());
};
const workMasksOf = async (it) => {
  if (it === S.cur && S.E) return S.E.masks;
  if (it.packing) await it.packing;
  return it.masksBlob ? store.unpackMasks(it.masksBlob, it.workW * it.workH) : null;
};
const ensureSmallMasks = async (it) => {
  if (it.smallMasks) return it.smallMasks;
  const v = it.maskVersion, n = it.smallW * it.smallH, m = await workMasksOf(it);
  const out = { G: new Uint8Array(n), P: new Uint8Array(n), S: new Uint8Array(n), ST: new Uint8Array(n) };
  if (m) {
    const mc = maskCanvases(m, it.workW, it.workH);
    const da = ctx2d(drawScaled(mc.a, it.workW, it.workH, it.smallW, it.smallH)).getImageData(0, 0, it.smallW, it.smallH).data;
    const db = ctx2d(drawScaled(mc.b, it.workW, it.workH, it.smallW, it.smallH)).getImageData(0, 0, it.smallW, it.smallH).data;
    for (let i = 0, j = 0; i < n; i++, j += 4) { out.G[i] = da[j]; out.P[i] = da[j + 1]; out.S[i] = da[j + 2]; out.ST[i] = db[j]; }
  }
  if (it.maskVersion === v) it.smallMasks = out;
  return out;
};
const renderPreview = async (it) => {
  const small = await ensureSmall(it), sm = await ensureSmallMasks(it), p = S.params;
  it.preview = await renderPrint({
    src: small, srcW: it.smallW, srcH: it.smallH, mc: maskCanvases(sm, it.smallW, it.smallH), outW: it.smallW, outH: it.smallH,
    params: p, stats: statsFrom(it.analysis, p), gains: gainsFor(it, p), grainScale: Math.min(1, (1.6 * it.smallW) / it.srcW), into: it.preview,
  });
};
let previewTimer = 0, previewBusy = false, previewAgain = false;
const schedulePreviews = (delay = 150) => { clearTimeout(previewTimer); previewTimer = setTimeout(runPreviews, delay); };
const previewKeyOf = (it) => `${lastKey}|${it.maskVersion}|${it.wbPickMed ? it.wbPickMed.join(',') : ''}|${it.analysisSize}`;
const visibleFirst = () => {
  const host = S.view === 'grid' ? $('#grid') : $('#film'), box = host.getBoundingClientRect(), vis = [], rest = [];
  for (const it of S.items) {
    const el = S.view === 'grid' ? it.els?.tile : it.els?.thumb, r = el && el.getBoundingClientRect();
    (r && r.width && r.bottom >= box.top && r.top <= box.bottom && r.right >= box.left && r.left <= box.right ? vis : rest).push(it);
  }
  const i = vis.indexOf(S.cur); if (i > 0) { vis.splice(i, 1); vis.unshift(S.cur); }
  return [...vis, ...rest];
};
const runPreviews = async () => {
  if (previewBusy) { previewAgain = true; return; }
  if (!needPreviews()) return;
  previewBusy = true;
  try {
    do {
      previewAgain = false;
      for (const it of visibleFirst()) {
        if (previewAgain) break;
        if (!S.items.includes(it)) continue;
        const key = previewKeyOf(it);
        if (it.previewKey === key) continue;
        try { await renderPreview(it); it.previewKey = key; paintItem(it); } catch (e) { console.warn('preview of', it.name, e); it.previewKey = key; }
        await yieldToPage();
      }
    } while (previewAgain);
  } finally { previewBusy = false; }
};
const showing = () => (editor.holdOriginal ? 'original' : S.show);
const overlayFor = (it) => {
  if (it.overlaySmall && it.overlayOp === editor.opacity) return it.overlaySmall;
  if (!it.small || !it.smallMasks) return it.small;
  const c = canvasOf(it.smallW, it.smallH), o = canvasOf(it.smallW, it.smallH), img = new ImageData(it.smallW, it.smallH);
  paintOverlay(img.data, it.smallMasks, it.smallW, 0, 0, it.smallW, it.smallH, editor.opacity);
  o.getContext('2d').putImageData(img, 0, 0);
  const g = c.getContext('2d'); g.drawImage(it.small, 0, 0); g.drawImage(o, 0, 0);
  it.overlaySmall = c; it.overlayOp = editor.opacity;
  return c;
};
const imageFor = (it) => {
  const show = showing();
  if (show === 'parts') return overlayFor(it);
  if (show === 'original' || !it.preview) return it.small;
  return it.preview;
};
const paintItem = (it) => {
  if (!it.els) return;
  const src = imageFor(it); if (!src) return;
  const tc = it.els.tc, fc = it.els.fc;
  if (tc.width !== src.width || tc.height !== src.height) { tc.width = src.width; tc.height = src.height; }
  const tg = tc.getContext('2d'); tg.clearRect(0, 0, tc.width, tc.height); tg.drawImage(src, 0, 0);
  const fh = 140, fw = Math.max(1, Math.round((fh * src.width) / src.height));
  if (fc.width !== fw || fc.height !== fh) { fc.width = fw; fc.height = fh; }
  const fg = fc.getContext('2d'); fg.imageSmoothingQuality = 'high'; fg.clearRect(0, 0, fw, fh); fg.drawImage(src, 0, 0, fw, fh);
};
const repaintAll = async () => {
  const show = showing();
  for (const it of S.items) {
    if (!it.els) continue;
    await ensureSmall(it);
    if (show === 'parts' && !it.smallMasks) await ensureSmallMasks(it);
    paintItem(it);
  }
};

// ---------- the batch: grid tiles and the strip ----------
const BADGE = { queued: 'Waiting to split', running: 'Splitting…', error: 'Not split' };
const buildItemEls = (it) => {
  const tile = document.createElement('div');
  tile.className = 'tile'; tile.setAttribute('role', 'option'); tile.dataset.id = it.id; tile.title = it.name;
  tile.innerHTML = '<div class="tbox"><canvas></canvas><span class="badge"></span></div><div class="tname"><span class="n"></span><button type="button" class="x" aria-label="Remove this photo" title="Remove">×</button></div>';
  tile.querySelector('.n').textContent = it.name;
  const thumb = document.createElement('button');
  thumb.type = 'button'; thumb.className = 'thumb'; thumb.setAttribute('role', 'option'); thumb.dataset.id = it.id; thumb.title = it.name;
  thumb.innerHTML = '<canvas></canvas><span class="tb"></span>';
  it.els = { tile, thumb, tc: tile.querySelector('canvas'), fc: thumb.querySelector('canvas'), badge: tile.querySelector('.badge'), tb: thumb.querySelector('.tb') };
  tile.addEventListener('click', (e) => { if (e.target.closest('.x')) { askRemove(it); return; } activate(it); });
  tile.addEventListener('dblclick', (e) => { if (e.target.closest('.x')) return; setDisplay('one'); activate(it); });
  thumb.addEventListener('click', () => activate(it));
  $('#grid').appendChild(tile); $('#film').appendChild(thumb);
  updateBadge(it);
  ensureSmall(it).then(() => paintItem(it)).catch(() => {});
};
const updateBadge = (it) => {
  if (!it.els) return;
  const s = it.split.status;
  it.els.badge.textContent = BADGE[s] || ''; it.els.badge.classList.toggle('err', s === 'error'); it.els.tb.dataset.s = s;
};
const selectEls = (it) => {
  for (const x of S.items) { if (!x.els) continue; const on = x === it; x.els.tile.setAttribute('aria-selected', String(on)); x.els.thumb.setAttribute('aria-selected', String(on)); }
  if (it && it.els) {
    if (S.view === 'grid') it.els.tile.scrollIntoView({ block: 'nearest' });
    else if (!$('#film').hidden) it.els.thumb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  updateNav();
};
const updateNav = () => {
  const target = S.navTarget || S.cur, i = S.items.indexOf(target);
  $('#navPos').textContent = S.items.length ? `${i + 1} of ${S.items.length}` : '';
  $('#navPrev').disabled = i <= 0; $('#navNext').disabled = i < 0 || i >= S.items.length - 1;
};
const updateBatchUI = () => {
  const n = S.items.length, grid = S.view === 'grid';
  document.body.classList.toggle('has-photo', n > 0);
  $('#grid').hidden = !grid || !n;
  $('#viewport').hidden = grid && n > 0;
  $('#film').hidden = grid || n < 2;
  $('#nav').hidden = grid || n < 2;
  $('#zoomTools').hidden = grid;
  $('#gridTools').hidden = !grid;
  $('#btnSaveProject').disabled = !n;
  $('#btnRemoveAll').disabled = !n;
  for (const b of [$('#btnExportAll'), $('#btnExportAll2')]) b.hidden = n < 2;
  $('#btnExportAll').textContent = `Save all ${n}`; $('#btnExportAll2').textContent = `Save all ${n} as a .zip`;
  updateLegend(); updateNav();
};
const setDisplay = (v) => {
  S.view = v; pressSeg($('#segDisplay'), v); updateBatchUI(); saveUI();
  if (v === 'grid') { if (S.cur) selectEls(S.cur); repaintAll(); }
  else { editor.cancelPoly(); if (editor.autoFit) editor.fit(); }
  schedulePreviews(60);
};
const setShow = (v) => {
  S.show = v; pressSeg($('#segView'), v); editor.setView(v);
  $('#viewport').classList.toggle('wipe', v === 'compare');
  updateLegend(); repaintAll(); saveUI();
};
const updateLegend = () => {
  const on = S.show === 'parts' && S.items.length > 0;
  $('#legend').hidden = !on;
  $('#viewarea').classList.toggle('legend-on', on); $('#viewarea').classList.toggle('grid-on', S.view === 'grid' && S.items.length > 0);
};
const gridCols = () => {
  const tiles = S.items.map((i) => i.els?.tile).filter(Boolean); if (tiles.length < 2) return 1;
  const top = tiles[0].offsetTop; let c = 0; for (const t of tiles) { if (t.offsetTop !== top) break; c++; }
  return Math.max(1, c);
};
// move through the batch; quick presses only open the photo you stop on
const go = (d) => {
  if (!S.items.length) return;
  const base = S.items.indexOf(S.navTarget || S.cur), j = Math.max(0, Math.min(S.items.length - 1, (base < 0 ? 0 : base) + d));
  const it = S.items[j]; if (!it || it === (S.navTarget || S.cur)) return;
  S.navTarget = it; selectEls(it);
  clearTimeout(S.navTimer); S.navTimer = setTimeout(() => { const t = S.navTarget; S.navTarget = null; activate(t); }, 160);
};

// ---------- the batch: removing ----------
const confirmDlg = (title, text, ok = 'Remove') => new Promise((res) => {
  const d = $('#confirmDlg'); $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; $('#confirmOk').textContent = ok;
  d.returnValue = ''; d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }); d.showModal();
});
const askRemove = async (it) => { if (await confirmDlg('Remove this photo?', `${it.name} and its parts leave the batch and this browser. The file on your computer isn’t touched.`)) removeItems([it]); };
const removeItems = async (list) => {
  const idx = S.items.indexOf(S.cur), curGone = list.includes(S.cur);
  for (const it of list) {
    const i = S.items.indexOf(it); if (i < 0) continue;
    S.items.splice(i, 1); S.queue = S.queue.filter((x) => x !== it);
    if (it.els) { it.els.tile.remove(); it.els.thumb.remove(); it.els = null; }
    clearTimeout(it._pt); clearTimeout(it._ft);
    store.deleteItem(it.id).catch(storeFailed);
  }
  saveOrder();
  if (curGone) {
    editor.cancelPoly(); S.cur = null; S.E = null; S.token++;
    const next = S.items[Math.min(Math.max(0, idx), S.items.length - 1)];
    if (next) await activate(next); else clearView();
  }
  updateBatchUI(); schedulePreviews();
};

// ---------- saving ----------
const zeroMasks = (n) => ({ G: new Uint8Array(n), P: new Uint8Array(n), S: new Uint8Array(n), ST: new Uint8Array(n) });
// the photo printed at its own size, from the original file, in tiles
const renderFull = async (it, onProgress) => {
  const p = clone(S.params);
  const masks = (await workMasksOf(it)) || zeroMasks(it.workW * it.workH);
  if (it.analysisSize !== 'work') {
    const { E } = await workingState(it);
    for (const k of ['G', 'P', 'S', 'ST']) E.masks[k].set(masks[k]);
    it.analysis = computeAnalysis(E, E.wbMed); it.analysisSize = 'work'; persist(it);
  }
  const bmp = await createImageBitmap(it.blob, { imageOrientation: 'from-image' });
  try {
    return await renderPrint({ src: bmp, srcW: bmp.width, srcH: bmp.height, mc: maskCanvases(masks, it.workW, it.workH), outW: bmp.width, outH: bmp.height, params: p, stats: statsFrom(it.analysis, p), gains: gainsFor(it, p), onProgress });
  } finally { bmp.close?.(); }
};
const formatFor = () => (S.params.bg.mode === 'transparent' && S.exp.format !== 'png' ? 'png' : S.exp.format);
const encode = (c, fmt) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('the browser could not encode the image'))), { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt], S.exp.quality));
const extOf = (fmt) => (fmt === 'jpeg' ? 'jpg' : fmt);
const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 8000); };
let saving = false;
const exportCurrent = async () => {
  const it = S.cur; if (!it || saving) return;
  saving = true;
  const fmt = formatFor();
  status(`Printing ${it.name} at ${it.srcW} × ${it.srcH} px…`, 'busy');
  await yieldToPage();
  try {
    const c = await renderFull(it, (f) => status(`Printing ${it.name}: ${Math.round(f * 100)}%…`, 'busy'));
    const blob = await encode(c, fmt), name = `${slug(it.outName || it.name)}.${extOf(fmt)}`;
    download(blob, name);
    status(`Saved ${name}: ${c.width} × ${c.height} px${fmt !== S.exp.format ? ' (PNG, to keep the transparency)' : ''}.`);
  } catch (e) { console.error(e); status('Couldn’t save the image: ' + (e.message || e), 'err'); }
  finally { saving = false; }
};
const exportAll = async () => {
  if (!S.items.length || saving) return;
  saving = true;
  try {
    if (S.cur) await flushParts(S.cur);
    const fmt = formatFor(), files = [], used = new Set(), failed = [], N = S.items.length;
    for (let k = 0; k < N; k++) {
      const it = S.items[k]; if (!it) break;
      status(`Printing ${k + 1} of ${N}: ${it.name}…`, 'busy');
      try {
        const c = await renderFull(it, (f) => status(`Printing ${k + 1} of ${N}: ${it.name}, ${Math.round(f * 100)}%…`, 'busy'));
        const base = slug(it.outName || it.name); let name = `${base}.${extOf(fmt)}`, q = 2;
        while (used.has(name)) name = `${base}-${q++}.${extOf(fmt)}`;
        used.add(name); files.push({ name, blob: await encode(c, fmt) });
        c.width = c.height = 0;
      } catch (e) { console.error(e); failed.push(it.name); }
      await yieldToPage();
    }
    if (!files.length) { status('Nothing could be saved.', 'err'); return; }
    status('Making the zip…', 'busy');
    download(await makeZip(files), `tuned-photos-${new Date().toISOString().slice(0, 10)}.zip`);
    status(`Saved ${plural(files.length, 'photo')} in one zip, each at its own size${failed.length ? `; ${failed.length} couldn’t be printed: ${failed.join(', ')}` : ''}.`, failed.length ? 'err' : '');
  } finally { saving = false; }
};

// ---------- projects: the whole batch in one .tuned.zip ----------
const loadImg = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
const saveProject = async () => {
  if (!S.items.length) return;
  status('Saving the project…', 'busy');
  try {
    if (S.cur) await flushParts(S.cur);
    for (const it of S.items) if (it.packing) await it.packing;
    const meta = { app: 'ea-tuned-by-part', version: 2, saved: new Date().toISOString(), params: S.params, current: S.items.indexOf(S.cur), items: [] }, files = [];
    for (const it of S.items) {
      const ext = ((it.name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || it.type.split('/')[1] || 'jpg').toLowerCase();
      const photo = `photos/${it.id}.${ext}`, parts = it.masksBlob ? `parts/${it.id}.bin` : null;
      files.push({ name: photo, blob: it.blob });
      if (parts) files.push({ name: parts, blob: it.masksBlob });
      meta.items.push({ name: it.name, type: it.type, outName: it.outName, split: it.split.status === 'done' || it.split.status === 'error' ? it.split : { status: 'none', note: '', people: 0 }, wbPick: it.wbPick, wbPickMed: it.wbPickMed, photo, parts, partsType: it.masksBlob ? it.masksBlob.type : null });
    }
    files.unshift({ name: 'project.json', blob: new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }) });
    const name = `${S.items.length === 1 ? slug(S.items[0].name) : 'tuned-batch'}-${new Date().toISOString().slice(0, 10)}.tuned.zip`;
    download(await makeZip(files), name);
    status(`Project saved: ${plural(S.items.length, 'photo')}, their parts and the settings. Open it here to carry on.`);
  } catch (e) { console.error(e); status('Couldn’t save the project: ' + (e.message || e), 'err'); }
};
// the levels from the working size, with the photo's parts
const analyseAtWork = async (it) => {
  const { E } = await workingState(it), m = it.masksBlob ? await store.unpackMasks(it.masksBlob, E.n) : null;
  if (m) for (const k of ['G', 'P', 'S', 'ST']) if (m[k]) E.masks[k].set(m[k]);
  it.analysis = computeAnalysis(E, E.wbMed); it.analysisSize = 'work';
};
const openProject = async (file) => {
  try {
    if (/\.json$/i.test(file.name) || file.type === 'application/json') { await openOldProject(file); return; }
    const zip = await readZip(file), pj = zip.get('project.json');
    if (!pj) throw new Error('there’s no project.json in it');
    const meta = JSON.parse(await (await pj()).text());
    if (meta.app !== 'ea-tuned-by-part') throw new Error('this isn’t a Tuned by part project');
    if (S.items.length && !(await confirmDlg('Open this project?', `The ${plural(S.items.length, 'photo')} open now leave the batch. Save a project first if you want to keep them.`, 'Open'))) return;
    await removeItems([...S.items]);
    S.params = merge(defaultParams(), meta.params || {}); S.params.wb.pick = null; syncUI();
    const added = [];
    for (let k = 0; k < meta.items.length; k++) {
      const m = meta.items[k], get = zip.get(m.photo); if (!get) continue;
      status(`Opening ${k + 1} of ${meta.items.length}: ${m.name}…`, 'busy');
      try {
        const it = await makeItem(new Blob([await get()], { type: m.type || '' }), m.name);
        it.outName = m.outName || it.outName; it.wbPick = m.wbPick || null; it.wbPickMed = m.wbPickMed || null;
        if (m.parts && zip.get(m.parts)) {
          it.masksBlob = store.withPartsType(await zip.get(m.parts)(), m.partsType);
          it.split = { status: m.split?.status === 'error' ? 'error' : 'done', note: m.split?.note || 'Opened from a project.', people: m.split?.people || 0 };
          await analyseAtWork(it);
        }
        S.items.push(it); added.push(it); buildItemEls(it); persist(it);
      } catch (e) { console.error(e); }
      await yieldToPage();
    }
    saveOrder(); updateBatchUI();
    await activate(added[Math.max(0, Math.min(added.length - 1, +meta.current || 0))]);
    if (S.autoSplit) S.items.filter((i) => i.split.status === 'none').forEach((i) => queueSplit(i));
    schedulePreviews(); rebuild('all');
    status(`Opened ${file.name}: ${plural(added.length, 'photo')}.`);
  } catch (e) { console.error(e); status('Couldn’t open the project: ' + (e.message || e), 'err'); }
};
// a project from the first version: one photo in a .tuned.json
const openOldProject = async (file) => {
  status('Opening the project…', 'busy');
  const proj = JSON.parse(await file.text());
  if (proj.app !== 'ea-tuned-by-part') throw new Error('this isn’t a Tuned by part project');
  const blob = await (await fetch(proj.image)).blob();
  S.params = merge(defaultParams(), proj.params || {}); S.params.wb.pick = null; syncUI();
  const it = await makeItem(blob, proj.name), n = it.workW * it.workH, masks = {};
  for (const key of ['G', 'P', 'S', 'ST']) {
    masks[key] = new Uint8Array(n);
    if (!proj.masks?.[key]) continue;
    const im = await loadImg(proj.masks[key]);
    const d = ctx2d(drawScaled(im, im.naturalWidth, im.naturalHeight, it.workW, it.workH)).getImageData(0, 0, it.workW, it.workH).data;
    for (let i = 0; i < n; i++) masks[key][i] = d[i * 4];
  }
  it.masksBlob = await store.packMasks(masks, n); it.split = { status: 'done', note: 'Opened from a project.', people: 0 };
  await analyseAtWork(it);
  S.items.push(it); buildItemEls(it); persist(it); saveOrder(); updateBatchUI();
  await activate(it); schedulePreviews(); rebuild('all');
  status(`Opened ${file.name}.`);
};

// ---------- the panel ----------
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

// the parts, each in its own colour
$('#legend').innerHTML = PARTS.map((p) => `<span><span class="dot" style="background:${p.hex}"></span>${p.label}</span>`).join('');
$$('.dot[data-part]').forEach((d) => { d.style.background = PART[d.dataset.part].hex; });
const segPart = $('#segPart');
for (const p of PARTS) {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.v = p.id; b.title = `${p.hint} (${p.key})`;
  b.innerHTML = `<span class="dot" style="background:${p.hex}"></span><span></span>`; b.lastChild.textContent = p.label;
  b.addEventListener('click', () => setPart(p.id)); segPart.appendChild(b);
}
const setPart = (v, user = true) => {
  editor.part = v; pressSeg(segPart, v); $('#partHint').textContent = PART[v].hint + '.';
  if (user && S.view === 'grid' && S.cur) setDisplay('one');
  editor.drawCursor();
};
const TOOL_HINTS = {
  brush: 'Paint the part. Hold Alt to erase. Snap keeps the stroke on the photo’s edges.',
  lasso: 'Click point by point round an area, then click the first point, double-click or press Enter to fill it. Backspace takes the last point back; Esc cancels. Hold Alt as you start, or tick Erase, to remove.',
  click: 'Click an object to add it to the part. Shift-click to add more of it; Alt-click to take an object out.',
  hand: 'Drag to move the photo. Pinch or Ctrl-scroll to zoom.',
};
const setTool = (v, user = true) => {
  if (editor.tool !== v) editor.cancelPoly();
  editor.tool = v; pressSeg($('#segTool'), v);
  const vp = $('#viewport'); for (const t of ['brush', 'lasso', 'click', 'hand']) vp.classList.toggle('tool-' + t, t === v);
  $('#rowBrush').hidden = v !== 'brush'; $('#toolHint').textContent = TOOL_HINTS[v];
  if (user) {
    if (S.view === 'grid' && S.cur) setDisplay('one');
    if (v !== 'hand' && (S.show === 'result' || S.show === 'compare') && S.cur) setShow('parts');
  }
  editor.drawCursor();
};
$$('#segTool button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.v)));
$$('#segView button').forEach((b) => b.addEventListener('click', () => setShow(b.dataset.v)));
$$('#segDisplay button').forEach((b) => b.addEventListener('click', () => setDisplay(b.dataset.v)));

const bindRange = (id, outId, fmtFn, onInput) => { const el = $(id), out = $(outId); const f = () => { out.textContent = fmtFn(+el.value); onInput(+el.value); }; el.addEventListener('input', f); f(); };
bindRange('#brushSize', '#brushSizeV', (v) => v + ' px', (v) => { editor.size = v; editor.drawCursor(); });
bindRange('#brushSoft', '#brushSoftV', (v) => v + '%', (v) => { editor.soft = v / 100; editor.drawCursor(); });
let overlayTimer = 0;
bindRange('#overlayOp', '#overlayOpV', (v) => v + '%', (v) => {
  editor.opacity = v / 100; if (S.E) editor.drawOverlay();
  clearTimeout(overlayTimer); overlayTimer = setTimeout(() => { if (showing() === 'parts') repaintAll(); }, 200);
});
$('#chkErase').addEventListener('change', (e) => { editor.erase = e.target.checked; editor.drawCursor(); });
$('#chkSnap').addEventListener('change', (e) => { editor.snap = e.target.checked; });
$('#btnUndo').addEventListener('click', () => editor.undo());
$('#btnRedo').addEventListener('click', () => editor.redo());
$('#btnClearPart').addEventListener('click', () => {
  const E = S.E; if (!E) return; const z = new Uint8Array(E.n), m = E.masks, part = editor.part;
  if (part === 'gear') editor.setMasks({ G: z, ST: z }, 'Clear the product');
  else if (part === 'kit') editor.setMasks({ P: Uint8Array.from(m.P, (v, i) => Math.round((v * m.S[i]) / 255)) }, 'Clear generic gear');
  else if (part === 'skin') editor.setMasks({ S: z }, 'Clear skin');
  else if (part === 'steel') editor.setMasks({ ST: z }, 'Clear steel');
  else status('The background is what’s left when the other parts are cleared.');
});
$('#btnClearAll').addEventListener('click', () => { const E = S.E; if (!E) return; const z = () => new Uint8Array(E.n); editor.setMasks({ G: z(), P: z(), S: z(), ST: z() }, 'Clear all parts'); });
$$('[data-whole]').forEach((b) => b.addEventListener('click', () => {
  const E = S.E, F = S.lastF; if (!E || !F) return; const z = new Uint8Array(E.n);
  if (b.dataset.whole === 'gear') editor.setMasks({ G: Uint8Array.from(F), P: z, S: z, ST: z }, 'The whole subject as the product');
  else editor.setMasks({ G: z, P: Uint8Array.from(F), S: toU8(skinWithin(E, toF32(F))), ST: z }, 'The whole subject as generic gear');
}));
$('#btnSplit').addEventListener('click', () => { if (S.cur) queueSplit(S.cur, true); });
$('#chkAutoSplit').checked = S.autoSplit;
$('#chkAutoSplit').addEventListener('change', (e) => {
  S.autoSplit = e.target.checked; saveUI();
  if (S.autoSplit) S.items.filter((i) => i.split.status === 'none').forEach((i) => queueSplit(i));
});

// colour by part: the product first, the background last, with the background's own options in its Fine-tune
const PART_ORDER = ['gear', 'kit', 'skin', 'place'];
const BG_HTML = `
  <label class="sl"><span class="lab">Lift toward the paper</span><input type="range" data-fade min="0" max="1" step="0.01"><output></output></label>
  <div class="bgopts">
    <span class="lab">The background</span>
    <div class="seg" id="segBg" role="group" aria-label="The background">
      <button type="button" data-v="keep" aria-pressed="true">Printed</button>
      <button type="button" data-v="transparent" aria-pressed="false">Transparent</button>
      <button type="button" data-v="fill" aria-pressed="false">Fill</button>
    </div>
    <div class="grp" id="grpFill" hidden>
      <span class="lab">Fill colour</span>
      <div class="swatches" id="fillSwatches"></div>
      <label class="sl"><span class="lab">Shadows kept</span><input type="range" data-p="bg.shadows" min="0" max="1" step="0.01"><output></output></label>
      <p class="hint">Shadows kept lays the background’s shading into the fill, so a shadow under the product stays.</p>
    </div>
    <p class="hint" id="bgHint"></p>
  </div>`;
seg($('#segMix'), MIXES.map((m) => [m.id, m.label, m.note]), matchMix(S.params), (id) => { applyMix(S.params, MIXES.find((m) => m.id === id)); syncUI(); scheduleRender(); });
const partsColour = $('#partsColour');
for (const key of PART_ORDER) {
  const info = PART[key], wrap = document.createElement('div'); wrap.className = 'partc'; wrap.dataset.part = key;
  wrap.innerHTML = `<div class="phead"><span class="dot" style="background:${info.hex}"></span><span class="lab"><span>${info.label}</span>${key === 'place' ? '<span class="state" id="bgState"></span>' : ''}</span><button type="button" class="mini" aria-expanded="false">Fine-tune</button></div>
    <div class="seg strength" role="group" aria-label="${info.label}"></div>
    <div class="adv" hidden>
      <label class="sl"><span class="lab">Colour kept</span><input type="range" data-f="k" min="0" max="1" step="0.01"><output></output></label>
      <label class="sl"><span class="lab">Cool colours kept</span><input type="range" data-f="cool" min="0" max="1" step="0.01"><output></output></label>
      <label class="sl"><span class="lab">Strongest colours rolled off at</span><input type="range" data-f="knee" min="0" max="80" step="1"><output></output></label>
      ${key === 'place' ? BG_HTML : ''}
    </div>`;
  partsColour.appendChild(wrap);
  seg(wrap.querySelector('.strength'), STRENGTH_LABELS, S.params.parts[key].preset, (v) => { S.params.parts[key] = { preset: v, ...STRENGTHS[v] }; syncUI(); scheduleRender(); });
  const mini = wrap.querySelector('.mini'), adv = wrap.querySelector('.adv');
  mini.addEventListener('click', () => { adv.hidden = !adv.hidden; mini.setAttribute('aria-expanded', String(!adv.hidden)); });
  wrap.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('input', () => {
    const p = S.params.parts[key]; p[inp.dataset.f] = +inp.value; p.preset = 'custom'; syncUI(); scheduleRender();
  }));
  const fade = wrap.querySelector('[data-fade]');
  if (fade) fade.addEventListener('input', () => { S.params.fade = +fade.value; syncUI(); scheduleRender(); });
}

// ink, white balance, the background's fill: inputs bound by their data-p path
$$('[data-p]').forEach((el) => {
  el.addEventListener('input', () => {
    const path = el.dataset.p, v = el.type === 'checkbox' ? el.checked : el.type === 'color' ? el.value.toUpperCase() : +el.value;
    setPath(S.params, path, v);
    const out = el.parentElement.querySelector('output'); if (out) out.textContent = fmt(path, v);
    const kind = rebuildKindFor(path);
    if (kind === 'render') { syncUI(); scheduleRender(); } else rebuild(kind);
    if (!S.E) scheduleRender();
  });
});
$$('#segInk button').forEach((b) => b.addEventListener('click', () => { S.params.ink.type = b.dataset.v; syncUI(); rebuild('stats'); if (!S.E) scheduleRender(); }));
$('#btnInkReset').addEventListener('click', () => { S.params.ink.colours = clone(defaultParams().ink.colours); syncUI(); scheduleRender(); });
$$('#segWB button').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.v;
  if (v === 'pick') {
    if (!S.cur) return;
    if (S.view === 'grid') setDisplay('one');
    editor.picking = true; $('#viewport').classList.add('picking'); pressSeg($('#segWB'), 'pick');
    status('Click something neutral in this photo: a grey card, a white sleeve, a wall.');
    return;
  }
  S.params.wb.mode = v; editor.picking = false; $('#viewport').classList.remove('picking'); syncUI(); rebuild('wb'); if (!S.E) scheduleRender();
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
  const list = ls.get(LS_PRESETS, []), ul = $('#presetList'); ul.innerHTML = '';
  if (!list.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'None yet. Saved settings stay in this browser.'; ul.appendChild(li); return; }
  list.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><button class="btn small" type="button" data-a="use">Use</button><button class="btn small" type="button" data-a="del" aria-label="Delete">Delete</button>';
    li.querySelector('.name').textContent = p.name;
    li.querySelector('[data-a=use]').addEventListener('click', () => { S.params = merge(defaultParams(), clone(p.params)); S.params.wb.pick = null; syncUI(); rebuild('all'); scheduleRender(); status(`Using “${p.name}” for every photo.`); });
    li.querySelector('[data-a=del]').addEventListener('click', () => { const l = ls.get(LS_PRESETS, []); l.splice(i, 1); ls.set(LS_PRESETS, l); renderPresets(); });
    ul.appendChild(li);
  });
};
$('#btnSavePreset').addEventListener('click', () => { $('#presetName').value = ''; $('#presetDlg').showModal(); });
$('#presetDlg').addEventListener('close', () => {
  if ($('#presetDlg').returnValue !== 'save') return;
  const name = $('#presetName').value.trim(); if (!name) return;
  const p = clone(S.params); p.wb.pick = null;
  const list = ls.get(LS_PRESETS, []).filter((x) => x.name !== name); list.push({ name, params: p }); ls.set(LS_PRESETS, list); renderPresets();
});
renderPresets();

// saving
$$('#segFormat button').forEach((b) => b.addEventListener('click', () => { S.exp.format = b.dataset.v; syncUI(); saveUI(); }));
bindRange('#exportQ', '#exportQV', (v) => String(v), (v) => { S.exp.quality = v / 100; saveUI(); });
$('#exportName').addEventListener('input', (e) => { const it = S.cur; if (!it) return; it.outName = e.target.value.trim() || slug(it.name); persist(it); });
for (const id of ['#btnExport', '#btnExport2']) $(id).addEventListener('click', exportCurrent);
for (const id of ['#btnExportAll', '#btnExportAll2']) $(id).addEventListener('click', exportAll);
$('#btnSaveProject').addEventListener('click', saveProject);
$('#btnRemoveAll').addEventListener('click', async () => { if (S.items.length && (await confirmDlg('Remove every photo?', `All ${plural(S.items.length, 'photo')} and their parts leave the batch and this browser. The files on your computer aren’t touched.`, 'Remove all'))) removeItems([...S.items]); });

// reflect the settings in every control
const BG_STATE = { keep: 'printed', transparent: 'removed', fill: 'filled' };
const syncUI = () => {
  const p = S.params;
  pressSeg($('#segMix'), matchMix(p)); const m = MIXES.find((x) => x.id === matchMix(p)); $('#mixHint').textContent = m ? m.note[0].toUpperCase() + m.note.slice(1) + '.' : 'Your own mix.';
  for (const key of PART_ORDER) {
    const wrap = partsColour.querySelector(`[data-part=${key}]`), pp = p.parts[key];
    pressSeg(wrap.querySelector('.strength'), pp.preset);
    wrap.querySelectorAll('[data-f]').forEach((inp) => { const f = inp.dataset.f; inp.value = pp[f]; inp.parentElement.querySelector('output').textContent = f === 'knee' ? (pp.knee > 0 ? String(Math.round(pp.knee)) : 'off') : Math.round(pp[f] * 100) + '%'; });
    const fade = wrap.querySelector('[data-fade]'); if (fade) { fade.value = p.fade; fade.parentElement.querySelector('output').textContent = Math.round(p.fade * 100) + '%'; }
  }
  const bgOff = p.bg.mode !== 'keep', placeSeg = partsColour.querySelector('[data-part=place] .strength');
  placeSeg.setAttribute('aria-disabled', String(bgOff)); placeSeg.title = bgOff ? 'The background isn’t printed (see Fine-tune)' : '';
  const fillName = (FILLS.find(([hex]) => hex === p.bg.fill) || [, 'a colour'])[1].toLowerCase();
  $('#bgState').textContent = p.bg.mode === 'fill' ? `filled with ${fillName}` : BG_STATE[p.bg.mode] || '';
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
  $('#bgHint').textContent = { keep: 'The background prints in the ink, with its own colour setting above.', transparent: 'The background is removed. The edges keep the subject’s own colour and tone, so no fringe of the old background is left. Saves as PNG.', fill: 'The background becomes a flat colour, as on the shop’s product cards (D117).' }[p.bg.mode];
  $('#wbHint').textContent = p.wb.mode === 'pick' ? 'Each photo uses the grey picked in it; photos without one use Auto. In a warm room, 60% keeps some warmth (D121).' : 'Auto balances each photo on its own brightest near-greys. In a warm room, 60% keeps some warmth (D121).';
  pressSeg($('#segFormat'), S.exp.format); $('#rowQuality').hidden = S.exp.format === 'png';
  $('#exportQ').value = Math.round(S.exp.quality * 100); $('#exportQV').textContent = String(Math.round(S.exp.quality * 100));
};

// ---------- files, drag and drop (folders too), paste ----------
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const fromFiles = (fl) => [...fl].map((f) => ({ blob: f, name: f.name })).sort(byName);
const openFiles = (fl) => {
  const list = [...fl];
  if (list.length === 1 && /\.(zip|json)$/i.test(list[0].name)) { openProject(list[0]); return; }
  addPhotos(fromFiles(list));
};
for (const id of ['#fileInput', '#fileInput2']) $(id).addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
$('#projInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openProject(f); e.target.value = ''; });
const walkEntries = async (entries) => {
  const out = [];
  const walk = async (entry, depth) => {
    if (!entry || depth > 8) return;
    if (entry.isFile) { const f = await new Promise((res) => entry.file(res, () => res(null))); if (f) out.push({ blob: f, name: f.name }); }
    else if (entry.isDirectory) {
      const rd = entry.createReader();
      for (;;) { const batch = await new Promise((res) => rd.readEntries(res, () => res([]))); if (!batch.length) break; for (const e of batch) await walk(e, depth + 1); }
    }
  };
  for (const e of entries) await walk(e, 0);
  return out.sort(byName);
};
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#viewport').classList.add('dragover'); $('#grid').classList.add('dragover'); } });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#viewport').classList.remove('dragover'); $('#grid').classList.remove('dragover'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#viewport').classList.remove('dragover'); $('#grid').classList.remove('dragover');
  const dt = e.dataTransfer; if (!dt) return;
  const files = [...dt.files];
  if (files.length === 1 && /\.(zip|json)$/i.test(files[0].name)) { openProject(files[0]); return; }
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const list = entries.length && entries.every(Boolean) ? await walkEntries(entries) : fromFiles(files);
  if (list.length) addPhotos(list);
  else if (dt.getData('text/uri-list')) status('That picture came from a web page that doesn’t let other pages read it. Save it to your computer and drop the file, or use Send photos (in Samples).', 'err');
});
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !['range', 'checkbox', 'radio', 'color'].includes(e.target.type);
window.addEventListener('paste', (e) => {
  if (typing(e)) return;
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) addPhotos(files.map((f, k) => ({ blob: f, name: f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${k + 1}.png` })));
});

// ---------- samples, and photos sent from a web page ----------
let samples = null;
const addSample = async (s) => { const blob = await (await fetch('../samples/' + s.file)).blob(); return { blob, name: s.file }; };
const showSamples = async () => {
  const grid = $('#sampleGrid');
  if (!samples) {
    try { samples = await (await fetch('../samples/samples.json')).json(); } catch (e) { samples = []; }
    grid.innerHTML = '';
    for (const s of samples) {
      const b = document.createElement('button'); b.type = 'button';
      b.innerHTML = '<img alt="" loading="lazy"><span class="t"></span><span class="c"></span>';
      b.querySelector('img').src = '../samples/' + s.file; b.querySelector('.t').textContent = s.title;
      b.querySelector('.c').innerHTML = `${s.creator}, <a href="${s.licenceUrl}" target="_blank" rel="noopener">${s.licence}</a>, <a href="${s.source}" target="_blank" rel="noopener">source</a>`;
      b.addEventListener('click', async (e) => { if (e.target.closest('a')) return; $('#samplesDlg').close(); addPhotos([await addSample(s)]); });
      grid.appendChild(b);
    }
  }
  $('#samplesDlg').showModal();
};
$('#btnSamples').addEventListener('click', showSamples);
$('#btnSamples2').addEventListener('click', showSamples);
$('#btnAllSamples').addEventListener('click', async () => { $('#samplesDlg').close(); const list = []; for (const s of samples || []) list.push(await addSample(s)); addPhotos(list); });
const grabUrl = new URL('../shared/grab.js', location.href).href;
$('#grabLink').href = `javascript:(()=>{const s=document.createElement('script');s.src='${grabUrl}?'+Date.now();document.documentElement.appendChild(s)})()`;
$('#grabLink').addEventListener('click', (e) => { e.preventDefault(); status('Drag that button to your bookmarks bar, then click the bookmark on a page with photos.'); });
// photos sent by the page that opened this one (the bookmark above): images only, kept in this browser
let restored = Promise.resolve();
window.addEventListener('message', async (e) => {
  if (!window.opener || e.source !== window.opener) return;
  const d = e.data; if (!d || d.type !== 'ea-tuner-photos' || !Array.isArray(d.photos)) return;
  await restored;
  const list = d.photos.filter((p) => p && p.blob instanceof Blob).slice(0, 200).map((p) => ({ blob: p.blob, name: String(p.name || 'photo').slice(0, 120) }));
  const added = await addPhotos(list);
  try { e.source.postMessage({ type: 'ea-tuner-received', count: added.length }, '*'); } catch (err) { /* the page has gone */ }
  if (added.length && !S.autoSplit) status(`Added ${plural(added.length, 'photo')} from ${String(d.from || 'another page').slice(0, 80)}.`);
});

// ---------- the side panel's width ----------
const app = $('#app'), splitter = $('#splitter');
const setPanelW = (w, save = true) => {
  const max = Math.max(320, Math.min(860, app.clientWidth - 380));
  S.panelW = Math.round(Math.max(300, Math.min(max, w))); app.style.setProperty('--panel-w', S.panelW + 'px');
  if (save) saveUI();
};
splitter.addEventListener('pointerdown', (e) => {
  e.preventDefault(); splitter.setPointerCapture(e.pointerId); splitter.classList.add('dragging'); document.body.classList.add('resizing');
  const move = (ev) => setPanelW(app.getBoundingClientRect().right - ev.clientX - 3, false);
  const up = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); splitter.removeEventListener('pointercancel', up); splitter.classList.remove('dragging'); document.body.classList.remove('resizing'); saveUI(); };
  splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', up); splitter.addEventListener('pointercancel', up);
});
splitter.addEventListener('dblclick', () => setPanelW(392));
splitter.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); setPanelW(S.panelW + 24); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); setPanelW(S.panelW - 24); }
});
window.addEventListener('resize', () => setPanelW(S.panelW, false));

// the grid's tile size
const setTile = (v) => { S.tile = v; $('#grid').style.setProperty('--tile', v + 'px'); $('#tileSize').value = v; saveUI(); };
$('#tileSize').addEventListener('input', (e) => { setTile(+e.target.value); schedulePreviews(200); });
$('#grid').addEventListener('scroll', () => schedulePreviews(200), { passive: true });
$('#film').addEventListener('scroll', () => schedulePreviews(200), { passive: true });
$('#navPrev').addEventListener('click', () => go(-1));
$('#navNext').addEventListener('click', () => go(1));

// ---------- zoom buttons and keys ----------
$('#zoomIn').addEventListener('click', () => editor.zoomTo(editor.scale * 1.25));
$('#zoomOut').addEventListener('click', () => editor.zoomTo(editor.scale / 1.25));
$('#zoomFit').addEventListener('click', () => editor.fit());
$('#zoom100').addEventListener('click', () => editor.zoomTo(1));
const setHold = (on) => { if (editor.holdOriginal === on) return; editor.holdOriginal = on; editor.updateLayers(); editor.drawCursor(); if (S.view === 'grid' || S.items.length > 1) repaintAll(); };
window.addEventListener('keydown', (e) => {
  if (typing(e) || $('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key;
  if (editor.poly) {
    if (k === 'Enter') { e.preventDefault(); editor.closePoly(); return; }
    if (k === 'Escape') { e.preventDefault(); editor.cancelPoly(); status('Lasso cancelled.'); return; }
    if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); editor.undoPolyPoint(); return; }
  }
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
  if (mod && k.toLowerCase() === 's') { e.preventDefault(); exportCurrent(); return; }
  if (mod && k === '0') { e.preventDefault(); editor.fit(); return; }
  if (mod || e.altKey && k.length === 1) return;
  const onControl = e.target.matches('input[type=range], .splitter');
  if ((k === 'ArrowLeft' || k === 'ArrowRight') && !onControl) { e.preventDefault(); go(k === 'ArrowLeft' ? -1 : 1); return; }
  if (S.view === 'grid' && (k === 'ArrowUp' || k === 'ArrowDown') && !onControl) { e.preventDefault(); go((k === 'ArrowUp' ? -1 : 1) * gridCols()); return; }
  if (S.view === 'grid' && k === 'Enter' && !e.target.matches('button, a')) { setDisplay('one'); return; }
  if (k === ' ') { if (e.target.matches('button, a, input')) return; if (!editor.spaceDown) { editor.spaceDown = true; $('#viewport').classList.add('space'); editor.drawCursor(); } e.preventDefault(); return; }
  if (k === '\\') { setHold(true); return; }
  if (k.toLowerCase() === 'g') { setDisplay(S.view === 'grid' ? 'one' : 'grid'); return; }
  const tools = { b: 'brush', l: 'lasso', c: 'click', h: 'hand' };
  if (tools[k.toLowerCase()]) { setTool(tools[k.toLowerCase()]); return; }
  const part = PARTS.find((p) => p.key === k); if (part) { setPart(part.id); return; }
  if (k === '[' || k === ']') { const el = $('#brushSize'); el.value = Math.max(2, Math.min(600, Math.round(+el.value * (k === ']' ? 1.2 : 1 / 1.2)))); el.dispatchEvent(new Event('input')); return; }
  if (k.toLowerCase() === 'x') { const c = $('#chkErase'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); return; }
  const views = { r: 'result', v: 'compare', p: 'parts', o: 'original' };
  if (views[k.toLowerCase()]) setShow(views[k.toLowerCase()]);
  else if (k.toLowerCase() === 'f') editor.fit();
  else if (k === '+' || k === '=') editor.zoomTo(editor.scale * 1.25);
  else if (k === '-') editor.zoomTo(editor.scale / 1.25);
  else if (k === 'Escape') { editor.picking = false; $('#viewport').classList.remove('picking'); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { editor.spaceDown = false; $('#viewport').classList.remove('space'); editor.drawCursor(); }
  if (e.key === '\\') setHold(false);
});
window.addEventListener('blur', () => { editor.spaceDown = false; setHold(false); $('#viewport').classList.remove('space'); });

// ---------- hand-over from the scene generator (same site, via IndexedDB) ----------
const idbGet = (key) => new Promise((res) => {
  try {
    const rq = indexedDB.open('ea-photo-tools', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('handoff');
    rq.onsuccess = () => { try { const g = rq.result.transaction('handoff', 'readonly').objectStore('handoff').get(key); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); } catch (e) { res(null); } };
    rq.onerror = () => res(null);
  } catch (e) { res(null); }
});

// ---------- the batch from last time ----------
const restoreBatch = async () => {
  let recs = [];
  try { recs = (await store.getItems()) || []; } catch (e) { storeFailed(e); }
  if (!recs.length) return;
  const order = (await store.getMeta('order').catch(() => null)) || [];
  const pos = (id) => { const i = order.indexOf(id); return i < 0 ? 1e9 : i; };
  recs.sort((a, b) => pos(a.id) - pos(b.id));
  for (const r of recs) { try { const it = itemFromRecord(r); S.items.push(it); buildItemEls(it); } catch (e) { console.warn('A saved photo couldn’t be restored', e); } }
  updateBatchUI();
  const curId = await store.getMeta('current').catch(() => null);
  await activate(S.items.find((i) => i.id === curId) || S.items[0]);
  if (S.autoSplit) S.items.filter((i) => i.split.status === 'none').forEach((i) => queueSplit(i));
  schedulePreviews();
  if (!S.queueRunning) status(`Your batch from last time: ${plural(S.items.length, 'photo')}.`);
};

// ---------- start ----------
setPanelW(S.panelW, false); setTile(S.tile);
syncUI(); setTool('brush', false); setPart('gear', false);
pressSeg($('#segDisplay'), S.view); pressSeg($('#segView'), S.show); editor.setView(S.show); $('#viewport').classList.toggle('wipe', S.show === 'compare');
updateBatchUI(); showPhotoUI(); scheduleRender();
restored = restoreBatch().catch((e) => console.error(e));
restored.then(async () => {
  if (location.hash.startsWith('#handoff')) { const h = await idbGet('tuner'); if (h && h.blob) addPhotos([{ blob: h.blob, name: h.name || 'generated.png' }], { gearMask: h.gearMask || null }); }
});
if (window.opener) { try { window.opener.postMessage({ type: 'ea-tuner-ready' }, '*'); } catch (e) { /* no opener */ } }
window.__tuner = { S, editor, gl, rebuild, addPhotos, activate, removeItems, exportCurrent, exportAll, renderFull, setDisplay, setShow, setTool, setPart, saveProject, openProject, queueSplit, runPreviews: () => runPreviews(), restored: () => restored, store };
