// Draws the two tray icons (a green dot while recording, a grey one when not paired) as
// 32×32 PNGs with nothing but Node: no image library to install, nothing to download.
// Run once: node scripts/make-icons.js → ui/icon.png, ui/icon-paused.png
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SIZE = 32;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A filled circle with a soft edge, as RGBA pixels. */
function dot([r, g, b]) {
  const rows = [];
  const cx = SIZE / 2 - 0.5, cy = SIZE / 2 - 0.5, radius = SIZE * 0.36;
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 4); // filter byte 0, then pixels
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = Math.max(0, Math.min(1, radius + 0.5 - d)); // anti-aliased edge
      row.set([r, g, b, Math.round(a * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function png(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(join(here, '..', 'ui'), { recursive: true });
writeFileSync(join(here, '..', 'ui', 'icon.png'), png(dot([52, 199, 89])));
writeFileSync(join(here, '..', 'ui', 'icon-paused.png'), png(dot([140, 140, 140])));
console.log('wrote ui/icon.png and ui/icon-paused.png');
