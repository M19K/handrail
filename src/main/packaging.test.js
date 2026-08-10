/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * What has to be INSIDE the app for it to work once packaged.
 *
 * These are the cheapest tests in the suite and they cover a class of bug that
 * every other layer is blind to. `npm test`, `scripts/smoke.js` and the
 * Playwright suite all run against the repo, where every file exists. A file
 * missing from `build.files` is invisible to all three and only shows up in the
 * artifact a user downloads.
 *
 * That is exactly how 0.1.3 shipped a macOS build with no tray icon: `main.js`
 * looked for artwork in `assets/` and `build/`, `build.files` listed neither,
 * and the packaged app fell through to "no tray icon on disk; tray not created".
 * With LSUIElement also removing the Dock icon, the shipped app had no visible
 * presence anywhere in the system — no menu bar item, no Dock icon, no window
 * on launch, and nothing to click to get it back.
 *
 * Windows was unaffected because `scripts/package-win.js` copies the artwork
 * explicitly, which is why nobody noticed for four releases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));

/** Does `build.files` include this repo-relative path? */
function isPackaged(file) {
  return (pkg.build.files || []).some((pattern) => {
    if (pattern.startsWith('!')) return false;
    const root = pattern.split('/')[0].replace(/\*.*$/, '');
    return root && file.startsWith(root);
  });
}

test('the macOS tray template image exists', () => {
  // Without this file the menu bar icon is the ONLY way back to a hidden
  // overlay on macOS, because LSUIElement means there is no Dock icon.
  assert.ok(
    fs.existsSync(path.join(ROOT, 'assets', 'trayTemplate.png')),
    'assets/trayTemplate.png is missing — run `node scripts/make-tray-icons.js`',
  );
});

test('the tray template has a @2x variant for Retina menu bars', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, 'assets', 'trayTemplate@2x.png')),
    'assets/trayTemplate@2x.png is missing — run `node scripts/make-tray-icons.js`',
  );
});

test('the tray template is mostly transparent, as a template image must be', () => {
  /**
   * The check that would have caught the blob.
   *
   * macOS keeps ONLY the alpha channel of a template image and re-tints the
   * silhouette to match the menu bar. 0.1.3 pointed this at the full app icon —
   * a dark rounded square, 98% opaque — so the "silhouette" was a filled
   * rectangle and the mark was invisible. A glyph is mostly empty space; an app
   * icon is not, and that difference is measurable.
   */
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'trayTemplate@2x.png'));

  // Alpha lives in the pixel data, so decode rather than guess. Only the fields
  // this assertion needs: 8-bit RGBA, non-interlaced, which is what the
  // generator writes.
  const zlib = require('node:zlib');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data[9];
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  assert.equal(colourType, 6, 'expected RGBA');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  let opaque = 0;
  for (let y = 0; y < height; y++) {
    // +1 skips the per-row filter byte. The generator writes filter 0 on every
    // row, so the scanline needs no reconstruction.
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < width; x++) if (row[x * 4 + 3] > 200) opaque++;
  }

  const ratio = opaque / (width * height);
  assert.ok(
    ratio < 0.6,
    `tray template is ${Math.round(ratio * 100)}% opaque — that is an app icon, not a glyph. ` +
    'As a template image macOS would render it as a solid blob.',
  );
  assert.ok(ratio > 0.05, `tray template is only ${Math.round(ratio * 100)}% opaque — it may be blank`);
});

test('build.files ships the assets directory', () => {
  // The actual 0.1.3 defect: the artwork existed in the repo and was simply
  // never copied into the app.
  assert.ok(
    isPackaged('assets/trayTemplate.png'),
    'build.files does not include assets/ — the packaged app will have no tray icon',
  );
});

test('every path main.js looks for a mac tray icon in is packaged', () => {
  // Pinned to the source rather than to a copy of the list, so moving the
  // lookup in main.js without updating build.files fails here.
  const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const macBranch = mainSource.slice(mainSource.indexOf('const candidates'), mainSource.indexOf('const found'));

  const referenced = [...macBranch.matchAll(/'([\w@.-]+\.(?:png|ico))'/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0, 'could not find any tray icon filenames in main.js');

  for (const file of referenced) {
    if (file.endsWith('.ico') || file.startsWith('tray-') || file.startsWith('icon-')) continue; // Windows paths
    assert.ok(
      fs.existsSync(path.join(ROOT, 'assets', file)),
      `main.js looks for assets/${file} but it does not exist`,
    );
  }
});

test('mac build does not claim microphone or camera access', () => {
  /**
   * v1 cut speech and has never used the camera.
   *
   * Electron's stock Info.plist carries placeholder strings for both, which
   * shipped in 0.1.3 — "This app needs access to the microphone", written by
   * somebody else, about a feature that does not exist. They are deleted by
   * `scripts/afterpack-mac.js`; this makes sure nobody re-adds them here.
   */
  const info = pkg.build.mac.extendInfo || {};
  assert.equal(info.NSMicrophoneUsageDescription, undefined);
  assert.equal(info.NSCameraUsageDescription, undefined);
});

test('mac build runs the afterPack hook that signs and cleans the bundle', () => {
  // Without it the .dmg is rejected by Gatekeeper as "damaged and can't be
  // opened", which has no in-UI workaround at all.
  assert.equal(pkg.build.afterPack, 'scripts/afterpack-mac.js');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.build.afterPack)));
});

test('hardened runtime stays off while the app is signed ad-hoc', () => {
  /**
   * Hardened Runtime turns on library validation, which requires every loaded
   * binary to share one Team ID. An ad-hoc signature has no Team ID, so turning
   * this on without a Developer ID certificate produces an app that cannot
   * load its own frameworks.
   *
   * It must go back to `true` at the same time real signing and notarisation
   * arrive — see PLATFORM.md — and not a moment before.
   */
  assert.equal(pkg.build.mac.hardenedRuntime, false);
});
