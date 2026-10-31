'use strict';
// Render the AUREN mark to website/favicon.ico and website/apple-touch-icon.png (no dependencies).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4);
  len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
function png(size, bg) {
  const SS = 4, N = size * SS, u = N / 64; // geometry is the 64-unit mark from favicon.svg
  const dist = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
  const hit = (x, y) => {
    const px = x / u, py = y / u;
    if (Math.abs(Math.hypot(px - 32, py - 32) - 28) <= 2.5) return true;
    if (dist(px, py, 19, 44, 32, 17) <= 2.75 || dist(px, py, 32, 17, 45, 44) <= 2.75) return true;
    return dist(px, py, 25, 36.5, 39, 36.5) <= 2.5;
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const fg = [0xe8, 0xb8, 0x4a];
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (hit(x * SS + sx + .5, y * SS + sy + .5)) n++;
      const a = n / (SS * SS), o = y * (size * 4 + 1) + 1 + x * 4;
      if (bg) { for (let i = 0; i < 3; i++) raw[o + i] = Math.round(fg[i] * a + bg[i] * (1 - a)); raw[o + 3] = 255; }
      else { raw[o] = fg[0]; raw[o + 1] = fg[1]; raw[o + 2] = fg[2]; raw[o + 3] = Math.round(a * 255); }
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(sizes) {
  const imgs = sizes.map((s) => png(s, null));
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = 6 + 16 * sizes.length; const dir = [];
  imgs.forEach((im, i) => { const e = Buffer.alloc(16); e[0] = sizes[i] % 256; e[1] = sizes[i] % 256; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(im.length, 8); e.writeUInt32LE(off, 12); off += im.length; dir.push(e); });
  return Buffer.concat([head, ...dir, ...imgs]);
}
const web = path.join(__dirname, '..', 'website');
fs.writeFileSync(path.join(web, 'favicon.ico'), ico([16, 32, 48]));
fs.writeFileSync(path.join(web, 'apple-touch-icon.png'), png(180, [0x0e, 0x0e, 0x11]));
fs.writeFileSync(path.join(__dirname, 'icon-256.png'), png(256, [0x0e, 0x0e, 0x11]));
const res = path.join(__dirname, '..', 'android', 'res', 'mipmap-xxxhdpi');
fs.mkdirSync(res, { recursive: true });
fs.writeFileSync(path.join(res, 'ic_launcher.png'), png(192, [0x0e, 0x0e, 0x11]));
console.log('wrote favicon.ico, apple-touch-icon.png and the Android launcher icon');
