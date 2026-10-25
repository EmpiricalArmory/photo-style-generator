// The split's models, run in a worker. The page stays responsive while they work, and if the graphics card fails the
// page ends this worker and starts a fresh one on the processor: after a failed WebGPU run, ONNX Runtime stays broken
// for the rest of its life, so trying again in the same place does not work.
//
// Messages in:  { id, type: 'init' | 'subject' | 'people' | 'samImage' | 'samQuery', ...data }
// Messages out: { id, type: 'progress', label, pct, mb } | { id, type: 'done', result } | { id, type: 'error', message, device }
import { TRANSFORMERS_URL, MODELS } from './models.js';

let T = null, device = 'wasm', sam = null;
const pipes = {};

const lib = async () => {
  if (!T) { T = await import(TRANSFORMERS_URL); T.env.allowLocalModels = false; }
  return T;
};

// download progress across a model's files, as one percentage
const progressFor = (id, label) => {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.file) files.set(p.file, [p.loaded || 0, p.total || 0]);
    if (p.status === 'done' && p.file && files.has(p.file)) { const [, t] = files.get(p.file); files.set(p.file, [t, t]); }
    let l = 0, t = 0; for (const [a, b] of files.values()) { l += a; t += b; }
    if (t > 0) self.postMessage({ id, type: 'progress', label, pct: Math.round((100 * l) / t), mb: Math.round(t / 1e6) });
  };
};
const say = (id, label) => self.postMessage({ id, type: 'progress', label, pct: null });

const pipe = async (id, task, key) => {
  const tf = await lib(), m = MODELS[key];
  if (!pipes[key]) pipes[key] = tf.pipeline(task, m.id, { device, dtype: m.dtype[device], progress_callback: progressFor(id, m.name) }).catch((e) => { delete pipes[key]; throw e; });
  return pipes[key];
};
const rawImage = async ({ rgba, w, h }) => { const tf = await lib(); return new tf.RawImage(new Uint8ClampedArray(rgba), w, h, 4); };

const handlers = {
  async init({ device: want }) {
    let gpu = false;
    if (want === 'webgpu' && self.navigator.gpu) { try { gpu = !!(await self.navigator.gpu.requestAdapter()); } catch (e) { /* no adapter */ } }
    device = gpu ? 'webgpu' : 'wasm';
    return { result: { device } };
  },

  // the subject's alpha (0..1), at the image's size
  async subject(msg, id) {
    const seg = await pipe(id, 'background-removal', 'subject');
    say(id, 'Finding the subject');
    const out = await seg(await rawImage(msg));
    const o = Array.isArray(out) ? out[0] : out, n = msg.w * msg.h;
    if (o.width !== msg.w || o.height !== msg.h) throw new Error('unexpected mask size');
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = o.data[i * o.channels + (o.channels - 1)] / 255;
    return { result: a, transfer: [a.buffer] };
  },

  // everything the detector sees, in the given image's pixels
  async people(msg, id) {
    const det = await pipe(id, 'object-detection', 'people');
    say(id, 'Finding people');
    const out = await det(await rawImage(msg), { threshold: 0.5 });
    return { result: out.map((o) => ({ label: o.label, score: o.score, box: o.box })) };
  },

  // Segment Anything: the photo is encoded once, then each click is quick
  async samImage(msg, id) {
    const tf = await lib(), m = MODELS.sam;
    if (!sam) {
      const model = await tf.SamModel.from_pretrained(m.id, { device, dtype: m.dtype[device], progress_callback: progressFor(id, m.name) });
      const processor = await tf.AutoProcessor.from_pretrained(m.id);
      sam = { model, processor };
    }
    say(id, 'Reading the photo for clicks');
    sam.emb = null;
    sam.raw = await rawImage(msg);
    sam.inputs = await sam.processor(sam.raw);
    sam.emb = await sam.model.get_image_embeddings(sam.inputs);
    sam.w = msg.w; sam.h = msg.h;
    return { result: true };
  },

  // points in image pixels; labels 1 = this object, 0 = not this. All three candidate masks (0/1), with scores
  async samQuery({ points, labels }) {
    if (!sam || !sam.emb) throw new Error('no photo has been read for clicks yet');
    const inp = await sam.processor(sam.raw, { input_points: [points], input_labels: [labels] });
    const out = await sam.model({ ...sam.emb, input_points: inp.input_points, input_labels: inp.input_labels });
    const masks = await sam.processor.post_process_masks(out.pred_masks, sam.inputs.original_sizes, sam.inputs.reshaped_input_sizes);
    const iou = Array.from(out.iou_scores.data), n = sam.w * sam.h, d = masks[0].data;
    const result = iou.map((score, k) => {
      const mask = new Uint8Array(n), off = k * n; let area = 0;
      for (let i = 0; i < n; i++) if (d[off + i]) { mask[i] = 1; area++; }
      return { mask, score, area };
    });
    return { result, transfer: result.map((r) => r.mask.buffer) };
  },
};

// one job at a time: a model can't run twice at once
let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      const handler = handlers[msg.type];
      if (!handler) throw new Error('unknown job ' + msg.type);
      const r = await handler(msg, msg.id);
      self.postMessage({ id: msg.id, type: 'done', result: r.result }, r.transfer || []);
    } catch (err) {
      self.postMessage({ id: msg.id, type: 'error', message: String((err && err.message) || err), device });
    }
  });
};
