/*
 * Icon generator (PR3) — produces the PWA's PNG icons (192/512) from scratch
 * using only Node's built-in zlib, so there's no image-library dependency.
 *
 * The icons are a dark square (theme background #1e1e1e) with a light terminal
 * prompt glyph: a ">" chevron + a "_" cursor underscore. Deliberately minimal —
 * a real designed icon is a fast-follow (see README "已知待补项").
 *
 * Reproduce with:  node scripts/generate-icons.mjs
 * Output:          public/icons/icon-192.png, public/icons/icon-512.png
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "icons");

// Colors (RGBA).
const BG = [0x1e, 0x1e, 0x1e, 0xff];
const FG = [0x4e, 0xc9, 0xff, 0xff]; // light blue, matches the terminal accent

/** Set a pixel in the RGBA buffer if in-bounds. */
function setPx(buf, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  buf[i] = color[0];
  buf[i + 1] = color[1];
  buf[i + 2] = color[2];
  buf[i + 3] = color[3];
}

/** Draw a filled rectangle (used as thick strokes for the glyph). */
function rect(buf, size, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPx(buf, size, x, y, color);
    }
  }
}

/** Render the icon's RGBA pixel buffer at a given size. */
function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  // Fill background.
  for (let p = 0; p < size * size; p++) {
    buf[p * 4] = BG[0];
    buf[p * 4 + 1] = BG[1];
    buf[p * 4 + 2] = BG[2];
    buf[p * 4 + 3] = BG[3];
  }

  // Geometry scaled to the canvas.
  const t = Math.max(2, Math.round(size * 0.06)); // stroke thickness
  const cx = Math.round(size * 0.34); // chevron apex x
  const top = Math.round(size * 0.3);
  const bottom = Math.round(size * 0.7);
  const reach = Math.round(size * 0.16); // chevron horizontal reach

  // ">" chevron: two diagonal strokes meeting at (cx, mid).
  const mid = Math.round((top + bottom) / 2);
  const steps = mid - top;
  for (let s = 0; s <= steps; s++) {
    const x = cx - reach + Math.round((reach * s) / steps);
    rect(buf, size, x, top + s, t, t, FG); // upper diagonal ↘
    rect(buf, size, x, bottom - s, t, t, FG); // lower diagonal ↗
  }

  // "_" cursor underscore to the right of the chevron, on the baseline.
  const underW = Math.round(size * 0.22);
  const underX = cx + Math.round(size * 0.08);
  rect(buf, size, underX, bottom, underW, t, FG);

  return buf;
}

/** Encode an RGBA buffer as a PNG (8-bit, color type 6). */
function encodePNG(rgba, size) {
  // Each scanline is prefixed with a filter-type byte (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Minimal CRC-32 (PNG chunk checksums).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const png = encodePNG(renderRGBA(size), size);
  const out = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
