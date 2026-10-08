import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type),
    size = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, data, checksum]);
}
function png(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size,
        py = (y + 0.5) / size;
      const inside =
        Math.hypot(Math.max(0.2 - px, 0, px - 0.8), Math.max(0.2 - py, 0, py - 0.8)) <= 0.18;
      const bar =
        py < 0.73 &&
        ((px > 0.24 && px < 0.36 && py > 0.48) ||
          (px > 0.44 && px < 0.56 && py > 0.27) ||
          (px > 0.64 && px < 0.76 && py > 0.37));
      const color = bar ? [115, 231, 193] : [25, 44, 40];
      const i = y * (1 + size * 4) + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[i + c] = color[c];
      raw[i + 3] = inside ? 255 : 0;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
mkdirSync('build', { recursive: true });
mkdirSync('public', { recursive: true });
writeFileSync('build/icon.png', png(256));
writeFileSync('public/icon.png', png(256));
const data = png(256),
  header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(data.length, 14);
header.writeUInt32LE(22, 18);
writeFileSync('build/icon.ico', Buffer.concat([header, data]));
console.log('Codex Dashboard icons generated.');
