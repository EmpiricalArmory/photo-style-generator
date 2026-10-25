// Splitting a photo into parts, in the browser: the subject (foreground), people, and the gear.
// Models run on the visitor's own machine through Transformers.js and ONNX Runtime Web (loaded from the jsDelivr CDN at a
// pinned version); the models' weights download once from Hugging Face and are cached by the browser. Nothing is uploaded.
//   subject:  onnx-community/ormbg-ONNX (Apache-2.0), or BiRefNet lite (MIT) where WebGPU is available
//   people:   Xenova/yolos-tiny (Apache-2.0), a small object detector, used for its "person" boxes
//   clicks:   Xenova/slimsam-77-uniform (Apache-2.0), Segment Anything distilled, for click-to-select
import { boxMean, guided, binarize, erode, dilate, components, sm, kmeans, nearest } from './imgproc.js';

export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
let T = null;
export const lib = async () => {
  if (T) return T;
  T = await import(TRANSFORMERS_URL); // ONNX Runtime's WebAssembly files come from the same CDN, at the version it pins
  T.env.allowLocalModels = false;
  return T;
};

let devicePromise = null;
export const pickDevice = () => (devicePromise ||= (async () => {
  try { if (navigator.gpu) { const a = await navigator.gpu.requestAdapter(); if (a) return 'webgpu'; } } catch (e) { /* no WebGPU */ }
  return 'wasm';
})());

export const MODELS = {
  subject: { id: 'onnx-community/ormbg-ONNX', name: 'Subject (ormbg)', dtype: { webgpu: 'fp16', wasm: 'q8' }, mb: { webgpu: 88, wasm: 44 } },
  subjectHQ: { id: 'onnx-community/BiRefNet_lite-ONNX', name: 'Subject, fine edges (BiRefNet lite)', dtype: { webgpu: 'fp16' }, mb: { webgpu: 115 } },
  people: { id: 'Xenova/yolos-tiny', name: 'People (YOLOS tiny)', dtype: { webgpu: 'fp32', wasm: 'q8' }, mb: { webgpu: 26, wasm: 10 } },
  sam: { id: 'Xenova/slimsam-77-uniform', name: 'Click to select (SlimSAM)', dtype: { webgpu: 'fp16', wasm: 'fp32' }, mb: { webgpu: 21, wasm: 40 } },
};

// collects download progress across a model's files into one percentage
const progressFor = (label, onProgress) => {
  const files = new Map();
  return (p) => {
    if (!onProgress) return;
    if (p.status === 'progress' && p.file) { files.set(p.file, [p.loaded || 0, p.total || 0]); }
    if (p.status === 'done' && p.file && files.has(p.file)) { const [, t] = files.get(p.file); files.set(p.file, [t, t]); }
    let l = 0, t = 0; for (const [a, b] of files.values()) { l += a; t += b; }
    if (t > 0) onProgress({ label, pct: Math.round((100 * l) / t), mb: Math.round(t / 1e6) });
  };
};

const cache = {};
const getPipeline = async (task, key, onProgress, forceDevice) => {
  const tf = await lib();
  const dev = forceDevice || (await pickDevice());
  const m = MODELS[key], ck = `${key}:${dev}`;
  if (!cache[ck]) {
    const dtype = m.dtype[dev] || m.dtype.wasm;
    cache[ck] = tf.pipeline(task, m.id, { device: dev, dtype, progress_callback: progressFor(m.name, onProgress) }).catch((e) => { delete cache[ck]; throw e; });
  }
  return cache[ck];
};

const rawFromCanvas = async (canvas) => { const tf = await lib(); return tf.RawImage.fromCanvas(canvas); };

// the subject's alpha (0..1) at the canvas's size
export const subjectMask = async (canvas, { hq = false, onProgress } = {}) => {
  const run = async (key, dev) => {
    const seg = await getPipeline('background-removal', key, onProgress, dev);
    onProgress?.({ label: 'Finding the subject', pct: null });
    const out = await seg(await rawFromCanvas(canvas));
    const o = Array.isArray(out) ? out[0] : out, n = canvas.width * canvas.height, a = new Float32Array(n);
    if (o.width !== canvas.width || o.height !== canvas.height) throw new Error('unexpected mask size');
    let s = 0;
    for (let i = 0; i < n; i++) { a[i] = o.data[i * o.channels + (o.channels - 1)] / 255; s += a[i]; }
    // a GPU that mishandles half floats gives an empty or full mask: treat that as a failure so WASM is tried
    const mean = s / n;
    if (!(mean > 0.002 && mean < 0.995)) throw new Error('the subject model returned an empty mask');
    return a;
  };
  const dev = await pickDevice();
  if (hq && dev === 'webgpu') { try { return await run('subjectHQ', 'webgpu'); } catch (e) { console.warn('BiRefNet failed, using ormbg', e); } }
  try { return await run('subject', dev); }
  catch (e) {
    if (dev === 'webgpu') { console.warn('WebGPU failed, trying WASM', e); onProgress?.({ label: 'The graphics card could not run it; trying the processor', pct: null }); return run('subject', 'wasm'); }
    throw e;
  }
};

// people: boxes {x0,y0,x1,y1,score} in canvas pixels, from a small copy of the photo
export const findPeople = async (canvas, { onProgress } = {}) => {
  const det = await getPipeline('object-detection', 'people', onProgress);
  onProgress?.({ label: 'Finding people', pct: null });
  const s = Math.min(1, 640 / Math.max(canvas.width, canvas.height)), sw = Math.round(canvas.width * s), sh = Math.round(canvas.height * s);
  const small = document.createElement('canvas'); small.width = sw; small.height = sh;
  const g = small.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, sw, sh);
  const out = await det(await rawFromCanvas(small), { threshold: 0.5 });
  const boxes = out.filter((o) => o.label === 'person' && o.score >= 0.6).map((o) => ({ x0: o.box.xmin / s, y0: o.box.ymin / s, x1: o.box.xmax / s, y1: o.box.ymax / s, score: o.score }))
    .filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) > 0.01 * canvas.width * canvas.height)
    .sort((a, b) => b.score - a.score);
  const keep = [];
  const inter = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = (a) => (a.x1 - a.x0) * (a.y1 - a.y0);
  for (const b of boxes) if (!keep.some((k) => { const i = inter(k, b); return i / Math.min(area(k), area(b)) > 0.7 || i / (area(k) + area(b) - i) > 0.5; })) keep.push(b);
  return keep;
};

// a plain-background fallback: colours along the border are the place, colours in the middle the subject
export const classicSubject = (E) => {
  const { w, h, n, lab, Ly } = E, bw = Math.max(4, Math.round(Math.min(w, h) * 0.04));
  const fg = [], bg = [], step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) {
    const x = i % w, y = (i / w) | 0, p = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
    if (x < bw || y < bw || x >= w - bw || y >= h - bw) bg.push(p);
    else if (x > w * 0.3 && x < w * 0.7 && y > h * 0.25 && y < h * 0.75) fg.push(p);
  }
  const CB = kmeans(bg, 6);
  const fgOnly = fg.filter((p) => nearest(CB, p[0], p[1], p[2]) > 60);
  const CF = kmeans(fgOnly.length > 50 ? fgOnly : fg, 6), p = new Float32Array(n);
  for (let i = 0; i < n; i++) { const dF = nearest(CF, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]), dB = nearest(CB, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]); p[i] = sm(0.35, 0.65, dB / (dF + dB + 1e-6)); }
  return guided(Ly, p, w, h, Math.max(2, Math.round(w / 300)), 1e-3);
};

// skin, by colour, inside people
export const skinWithin = (E, P) => {
  const { w, h, n, lab, Ly } = E, S0 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (P[i] < 0.5) continue;
    const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2], C = Math.hypot(a, b); let hd = Math.atan2(b, a) * 57.29578; if (hd < 0) hd += 360;
    // skin is warm (hue about 20–65°) and moderately saturated; beige linen and tan leather sit just outside
    S0[i] = sm(30, 40, L) * (1 - sm(86, 94, L)) * sm(10, 16, C) * (1 - sm(45, 58, C)) * sm(18, 26, hd) * (1 - sm(60, 70, hd));
  }
  return guided(Ly, boxMean(S0, w, h, 1), w, h, Math.max(2, Math.round(w / 260)), 4e-3);
};

// the whole split: subject -> people (blob-like parts inside person boxes, completed with Segment Anything) -> gear
// (the rest of the subject, and long thin parts such as blades held by people) -> skin (by colour, inside people)
export const autoSplit = async (E, canvas, { hq = false, onProgress, smart = null, smartKey = null } = {}) => {
  const { w, h, n, Ly } = E, notes = [];
  let F;
  try { F = await subjectMask(canvas, { hq, onProgress }); }
  catch (e) { console.warn('Subject model failed; using the plain-background method', e); notes.push('The subject model could not run here, so the plain-background method was used.'); F = classicSubject(E); }
  F = guided(Ly, F, w, h, Math.max(2, Math.round(Math.max(w, h) / 600)), 1e-3);
  let boxes = [];
  try { boxes = await findPeople(canvas, { onProgress }); }
  catch (e) { console.warn('People detector failed', e); notes.push('People could not be found automatically; paint them as Kit.'); }
  onProgress?.({ label: 'Splitting the parts', pct: null });
  await new Promise((r) => setTimeout(r, 0));
  const Fb = binarize(F, 0.5);
  let G, P;
  if (!boxes.length) { G = F; P = new Float32Array(n); }
  else {
    const Bx = new Float32Array(n);
    for (const b of boxes) {
      const px = (b.x1 - b.x0) * 0.04, py = (b.y1 - b.y0) * 0.03;
      const x0 = Math.max(0, Math.floor(b.x0 - px)), x1 = Math.min(w, Math.ceil(b.x1 + px)), y0 = Math.max(0, Math.floor(b.y0 - py)), y1 = Math.min(h, Math.ceil(b.y1 + py));
      for (let y = y0; y < y1; y++) Bx.fill(1, y * w + x0, y * w + x1);
    }
    const inBox = new Float32Array(n); for (let i = 0; i < n; i++) inBox[i] = Fb[i] * Bx[i];
    const r = Math.max(3, Math.round(0.012 * Math.max(w, h)));
    const body0 = dilate(erode(inBox, w, h, r), w, h, r), bodyG = dilate(body0, w, h, Math.max(1, r >> 1));
    const body = new Float32Array(n), cand = new Float32Array(n);
    for (let i = 0; i < n; i++) { body[i] = bodyG[i] * inBox[i]; cand[i] = Fb[i] * (1 - body[i]); }
    // what is left of the subject: long thin pieces (blades, often crossing a person's box) and objects away from
    // people are gear; short bits inside a person's box (fingers, straps, hair) belong to the person
    const gear = new Float32Array(n), person = Float32Array.from(body), diag = Math.hypot(w, h);
    const cc = components(cand, w, h), inside = new Float64Array(cc.stats.length);
    for (let i = 0; i < n; i++) { const l = cc.lab[i]; if (l) inside[l] += Bx[i]; }
    for (let k = 1; k < cc.stats.length; k++) {
      const s = cc.stats[k], long = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 0.06 * diag, inFrac = inside[k] / s.area;
      s.to = long ? 'gear' : inFrac >= 0.5 ? 'person' : s.area > 0.002 * n ? 'gear' : 'none';
    }
    for (let i = 0; i < n; i++) { const l = cc.lab[i]; if (l) { const t = cc.stats[l].to; if (t === 'gear') gear[i] = 1; else if (t === 'person') person[i] = 1; } }
    // complete each person with Segment Anything (arms the subject model was unsure of), within the subject's
    // likely pixels; the same photo encoding then serves click-to-select
    if (smart) {
      try {
        await smart.setImage(canvas, smartKey, onProgress);
        onProgress?.({ label: 'Completing the people', pct: null });
        for (const b of boxes) {
          const pts = [], x0 = Math.max(0, Math.round(b.x0)), x1 = Math.min(w, Math.round(b.x1));
          for (const fy of [0.3, 0.55, 0.8]) {
            const y = Math.min(h - 1, Math.round(b.y0 + (b.y1 - b.y0) * fy)); let s = 0, c = 0;
            for (let x = x0; x < x1; x++) if (body[y * w + x] > 0.5) { s += x; c++; }
            if (c > 3) pts.push([s / c, y]);
          }
          if (!pts.length) continue;
          const cands = await smart.queryAll(pts, pts.map(() => 1));
          const bx0 = b.x0 - (b.x1 - b.x0) * 0.08, bx1 = b.x1 + (b.x1 - b.x0) * 0.08, by0 = b.y0 - (b.y1 - b.y0) * 0.05, by1 = b.y1 + (b.y1 - b.y0) * 0.05;
          const boxArea = (b.x1 - b.x0) * (b.y1 - b.y0), best = Math.max(...cands.map((c) => c.score));
          const pick = cands.filter((c) => c.score >= best - 0.08 && c.area < boxArea * 1.1).sort((a, c) => c.area - a.area)[0];
          if (!pick) continue;
          for (let y = Math.max(0, Math.floor(by0)); y < Math.min(h, Math.ceil(by1)); y++) for (let x = Math.max(0, Math.floor(bx0)); x < Math.min(w, Math.ceil(bx1)); x++) {
            const i = y * w + x; if (pick.mask[i] > 0.5 && F[i] > 0.15 && !gear[i]) person[i] = 1;
          }
        }
      } catch (e) { console.warn('Completing people with Segment Anything failed', e); }
    }
    const rr = Math.max(2, Math.round(Math.max(w, h) / 500));
    P = guided(Ly, person, w, h, rr, 1e-3); G = guided(Ly, gear, w, h, rr, 2e-3);
    for (let i = 0; i < n; i++) { P[i] = Math.min(P[i], Math.max(F[i], person[i]) * 1.05); G[i] = Math.min(G[i], Math.max(F[i], gear[i]) * 1.05); }
    notes.push(`${boxes.length} ${boxes.length === 1 ? 'person' : 'people'} found. Gear being worn counts as kit until you mark it as the gear.`);
  }
  const S = skinWithin(E, P);
  return { G, P, S, F, boxes, notes };
};

// click to select (Segment Anything): the photo is encoded once, then each click returns a mask in ~0.1–1 s
export class SmartSelect {
  constructor() { this.ready = null; this.key = null; }
  async load(onProgress) {
    if (this.model) return;
    const tf = await lib(), dev = await pickDevice(), m = MODELS.sam;
    const opts = { device: dev, dtype: m.dtype[dev], progress_callback: progressFor(m.name, onProgress) };
    try { this.model = await tf.SamModel.from_pretrained(m.id, opts); }
    catch (e) { if (dev !== 'webgpu') throw e; this.model = await tf.SamModel.from_pretrained(m.id, { ...opts, device: 'wasm', dtype: m.dtype.wasm }); }
    this.processor = await tf.AutoProcessor.from_pretrained(m.id);
  }
  async setImage(canvas, key, onProgress) {
    if (this.key === key && this.emb) return;
    await this.load(onProgress);
    onProgress?.({ label: 'Reading the photo for clicks', pct: null });
    this.raw = await rawFromCanvas(canvas);
    this.inputs = await this.processor(this.raw);
    this.emb = await this.model.get_image_embeddings(this.inputs);
    this.key = key; this.w = canvas.width; this.h = canvas.height;
  }
  // points in canvas pixels; labels 1 = this object, 0 = not this. All three candidate masks, with their scores
  async queryAll(points, labels) {
    const inp = await this.processor(this.raw, { input_points: [points], input_labels: [labels] });
    const out = await this.model({ ...this.emb, input_points: inp.input_points, input_labels: inp.input_labels });
    const masks = await this.processor.post_process_masks(out.pred_masks, this.inputs.original_sizes, this.inputs.reshaped_input_sizes);
    const iou = Array.from(out.iou_scores.data), n = this.w * this.h, d = masks[0].data;
    return iou.map((score, k) => { const m = new Float32Array(n), off = k * n; let area = 0; for (let i = 0; i < n; i++) if (d[off + i]) { m[i] = 1; area++; } return { mask: m, score, area }; });
  }
  async query(points, labels) {
    const all = await this.queryAll(points, labels);
    return all.reduce((a, b) => (b.score > a.score ? b : a));
  }
}
