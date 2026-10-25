// Keeping the batch in this browser (IndexedDB): each photo as it came, its parts (compressed), what its levels are
// worked out from, and the order. Nothing leaves the machine; removing a photo deletes it here too.
const DB = 'ea-tuner', VER = 1;
let dbp = null;
const db = () => (dbp ||= new Promise((res, rej) => {
  if (!('indexedDB' in self)) { rej(new Error('no IndexedDB')); return; }
  const rq = indexedDB.open(DB, VER);
  rq.onupgradeneeded = () => {
    const d = rq.result;
    if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
  };
  rq.onsuccess = () => res(rq.result);
  rq.onerror = () => rej(rq.error);
  rq.onblocked = () => rej(new Error('storage blocked'));
}).catch((e) => { console.warn('The batch can’t be kept in this browser:', e); return null; }));

const run = async (storeName, mode, fn) => {
  const d = await db(); if (!d) return null;
  return new Promise((res, rej) => {
    const t = d.transaction(storeName, mode), rq = fn(t.objectStore(storeName));
    t.oncomplete = () => res(rq ? rq.result : undefined);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
  });
};
export const available = async () => !!(await db());
export const putItem = (rec) => run('items', 'readwrite', (s) => s.put(rec));
export const deleteItem = (id) => run('items', 'readwrite', (s) => s.delete(id));
export const getItems = () => run('items', 'readonly', (s) => s.getAll());
export const clearItems = () => run('items', 'readwrite', (s) => s.clear());
export const putMeta = (k, v) => run('meta', 'readwrite', (s) => s.put(v, k));
export const getMeta = (k) => run('meta', 'readonly', (s) => s.get(k));

// a photo's parts as one compressed blob: product, person, skin share, steel share and the subject, each a byte a pixel
const KEYS = ['G', 'P', 'S', 'ST', 'F'];
const DEFLATE = 'application/x-ea-parts-deflate', RAW = 'application/x-ea-parts';
export const packMasks = async (masks, n) => {
  const buf = new Uint8Array(n * KEYS.length);
  KEYS.forEach((k, q) => { if (masks[k]) buf.set(masks[k], q * n); });
  if (typeof CompressionStream === 'undefined') return new Blob([buf], { type: RAW });
  const z = await new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('deflate'))).blob();
  return new Blob([z], { type: DEFLATE });
};
export const unpackMasks = async (blob, n) => {
  const buf = blob.type === RAW ? new Uint8Array(await blob.arrayBuffer())
    : new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  if (buf.length < n * 4) throw new Error('the saved parts don’t fit this photo');
  const out = {};
  KEYS.forEach((k, q) => { out[k] = buf.length >= (q + 1) * n ? buf.slice(q * n, (q + 1) * n) : null; });
  return out;
};
export const withPartsType = (blob, type) => new Blob([blob], { type: type === RAW ? RAW : DEFLATE });
