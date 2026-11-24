// Reference solve for chapter III, "Exhibit 7" (what a player does, in one script).
//   1. pngcheck / exiftool: the Description says the exhibit was "Cropped for the record", and the IDAT stream
//      inflates to more rows than IHDR claims (zlib data left over after 1024 rows).
//   2. Rows = inflated length / (1 + width * 3); write that height into IHDR, fix the IHDR CRC.
//   3. Open the repaired picture: the forger's note under the drawing names the place.
// node solve.mjs exhibit7.png fixed.png
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const [inFile, outFile = 'fixed.png'] = process.argv.slice(2);
const png = readFileSync(inFile);
const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

let o = 8, idat = [], ihdrAt = -1;
while (o < png.length) {
  const len = png.readUInt32BE(o), type = png.toString('latin1', o + 4, o + 8);
  if (type === 'IHDR') ihdrAt = o;
  if (type === 'tEXt') console.log('tEXt', png.toString('latin1', o + 8, o + 8 + len).replace('\0', ' = '));
  if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
  o += 12 + len;
}
const width = png.readUInt32BE(ihdrAt + 8), claimed = png.readUInt32BE(ihdrAt + 12);
const rows = inflateSync(Buffer.concat(idat)).length / (1 + width * 3);
console.log(`IHDR says ${width}x${claimed}; the data holds ${rows} rows`);
const fixed = Buffer.from(png);
fixed.writeUInt32BE(rows, ihdrAt + 12);
fixed.writeUInt32BE(crc(fixed.subarray(ihdrAt + 4, ihdrAt + 8 + 13)), ihdrAt + 8 + 13);
writeFileSync(outFile, fixed);
console.log(`wrote ${outFile}: open it and read the note under the drawing`);
