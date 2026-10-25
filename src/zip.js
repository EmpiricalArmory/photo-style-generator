// A small ZIP writer and reader: the saved photos of a batch go out as one .zip, and a batch project is a .zip of its
// photos, parts and settings. Files are stored as they are (photos are already compressed); the reader also takes
// deflated entries, so a project re-zipped by another program still opens.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const dos = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });

// files: [{ name, blob }]; returns a Blob
export const makeZip = async (files) => {
  const enc = new TextEncoder(), { time, date } = dos(new Date()), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer()), crc = crc32(data), name = enc.encode(f.name), size = data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, f.blob);
    central.push({ name, crc, size, offset });
    offset += 30 + name.length + size;
  }
  const cd = []; let cdSize = 0;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0800, true); h.setUint16(10, 0, true);
    h.setUint16(12, time, true); h.setUint16(14, date, true); h.setUint32(16, c.crc, true); h.setUint32(20, c.size, true); h.setUint32(24, c.size, true);
    h.setUint16(28, c.name.length, true); h.setUint16(30, 0, true); h.setUint16(32, 0, true); h.setUint16(34, 0, true); h.setUint16(36, 0, true);
    h.setUint32(38, 0, true); h.setUint32(42, c.offset, true);
    cd.push(h.buffer, c.name); cdSize += 46 + c.name.length;
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true); e.setUint16(20, 0, true);
  return new Blob([...parts, ...cd, e.buffer], { type: 'application/zip' });
};

// returns a Map of name -> async () => Blob
export const readZip = async (blob) => {
  const tailLen = Math.min(blob.size, 22 + 65535), tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let p = -1; for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error('this isn’t a zip file');
  const count = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), dec = new TextDecoder(), out = new Map();
  for (let i = 0, q = 0; i < count; i++) {
    if (cd.getUint32(q, true) !== 0x02014b50) throw new Error('the zip file is damaged');
    const method = cd.getUint16(q + 10, true), csize = cd.getUint32(q + 20, true), nlen = cd.getUint16(q + 28, true), xlen = cd.getUint16(q + 30, true), clen = cd.getUint16(q + 32, true), loff = cd.getUint32(q + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + q + 46, nlen));
    out.set(name, async () => {
      const lh = new DataView(await blob.slice(loff, loff + 30).arrayBuffer()), start = loff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const raw = blob.slice(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      throw new Error('a file in the zip uses a compression this page can’t read');
    });
    q += 46 + nlen + xlen + clen;
  }
  return out;
};
