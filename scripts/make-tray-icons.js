/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — generate the macOS menu bar template icons.
 *
 *   node scripts/make-tray-icons.js
 *
 * Writes `assets/trayTemplate.png` (16x16) and `assets/trayTemplate@2x.png`
 * (32x32) from the same mark geometry as `design/brand/app-icon.svg`.
 *
 * WHY THIS EXISTS
 *
 * A macOS menu bar icon is a TEMPLATE image: macOS throws away the colour and
 * keeps only the ALPHA channel, then re-tints the silhouette to match the menu
 * bar — black in a light bar, white in a dark one, inverted when the menu is
 * open. That is the only way an icon looks native in both themes.
 *
 * Handrail 0.1.3 called `setTemplateImage(true)` on `build/icon-16.png`, which
 * is the full app icon: a dark rounded square with the mint mark inside it.
 * 252 of its 256 pixels are opaque, so as a template it is a filled rectangle.
 * The shipped result was a solid white blob in the menu bar with the mark
 * completely invisible. Verified on screen before this file was written.
 *
 * The fix is not a code change, it is an ASSET: a glyph drawn as alpha only,
 * with the shape carried by transparency rather than by colour.
 *
 * NO DEPENDENCY, ON PURPOSE
 *
 * The mark is two shapes — one round-capped stroked path and one disc — so the
 * coverage of a pixel is just a distance query, and PNG is `zlib` plus a header.
 * Adding a rasteriser and an image library to the build to draw a circle and a
 * bent line would be a bigger liability than the 150 lines below. Same reasoning
 * as the hand-written .ico encoder in `scripts/package-win.js`.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');

// --- the mark, on the same 24-unit grid as design/brand/app-icon.svg --------

const STROKE_W = 2.6;
const GRIP = { x: 8, y: 9, r: 3.4 };

/**
 * The rail: `M3 9 h11.5 c3 0 4.5 1.6 4.5 4.5 V20`, flattened to a polyline.
 *
 * Flattening rather than solving the cubic: at 32 physical pixels across, 24
 * samples of the curve are far below the size of a pixel, so the error is not
 * representable in the output.
 */
function railPoints() {
  const pts = [{ x: 3, y: 9 }, { x: 14.5, y: 9 }];

  const p0 = { x: 14.5, y: 9 };
  const c1 = { x: 17.5, y: 9 };
  const c2 = { x: 19, y: 10.6 };
  const p1 = { x: 19, y: 13.5 };
  const STEPS = 24;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
    });
  }

  pts.push({ x: 19, y: 20 });
  return pts;
}

/** Distance from a point to a line segment. */
function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Signed distance to the mark: negative inside, positive outside.
 *
 * The union of the two shapes is the minimum of their distances, which is what
 * gives the grip and the rail a single continuous silhouette rather than two
 * overlapping ones with a seam where they meet.
 */
function distanceToMark(x, y, rail) {
  let d = Infinity;
  for (let i = 0; i < rail.length - 1; i++) {
    d = Math.min(d, distToSegment(x, y, rail[i], rail[i + 1]) - STROKE_W / 2);
  }
  return Math.min(d, Math.hypot(x - GRIP.x, y - GRIP.y) - GRIP.r);
}

// --- rasterise --------------------------------------------------------------

/**
 * The mark's own ink box on the 24 grid.
 *
 * Not 0-24. The artwork does not fill its box: including stroke width it spans
 * x 1.7-20.3 and y 5.6-21.3. Fitting the BOX rather than the INK is the same
 * mistake `app-icon.svg` calls out — it leaves the glyph visibly off-centre in
 * the menu bar, and at 16px that reads as a bug rather than as a style.
 */
const INK = { x0: 1.7, y0: 5.6, x1: 20.3, y1: 21.3 };

/** Leave a little air. A menu bar glyph that touches its own edges looks cramped next to Apple's. */
const PAD = 0.5;

function render(size) {
  const rail = railPoints();

  const inkW = INK.x1 - INK.x0;
  const inkH = INK.y1 - INK.y0;
  const scale = Math.min((size - PAD * 2) / inkW, (size - PAD * 2) / inkH);
  const offX = (size - inkW * scale) / 2 - INK.x0 * scale;
  const offY = (size - inkH * scale) / 2 - INK.y0 * scale;

  // 4x4 supersampling. macOS does not smooth a template image for you, and at
  // this size an aliased edge is the difference between a crisp mark and a
  // jagged one sitting next to Apple's own perfectly smooth glyphs.
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = ((px + (sx + 0.5) / SS) - offX) / scale;
          const gy = ((py + (sy + 0.5) / SS) - offY) / scale;
          if (distanceToMark(gx, gy, rail) <= 0) hits++;
        }
      }
      const i = (py * size + px) * 4;
      // Black, with the shape carried entirely by alpha — the template contract.
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }

  return rgba;
}

// --- PNG --------------------------------------------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // Filter type 0 on every row. The image is 32x32 at most; a filter search
  // would save bytes that do not matter and add code that could be wrong.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- go ---------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // The @2x suffix is a macOS convention, not a decoration: `nativeImage`
  // reads `foo.png` and automatically picks up `foo@2x.png` beside it for
  // Retina. Without the 2x file the menu bar upscales the 16px art and the
  // mark goes soft on every Mac sold in the last decade.
  for (const [size, name] of [[16, 'trayTemplate.png'], [32, 'trayTemplate@2x.png']]) {
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, encodePng(render(size), size));
    console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${size}x${size})`);
  }
}

main();
