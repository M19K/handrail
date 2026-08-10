/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — icon generation.
 *
 * Rasterises design/brand/app-icon.svg into the PNG sizes electron-builder
 * needs.
 *
 * Uses Electron itself as the rasteriser rather than adding sharp, ImageMagick
 * or a native canvas binding. Electron is already a dependency, it renders SVG
 * exactly as the app will, and this machine has no Python or ImageMagick — a
 * build step that needs a toolchain the developer does not have is a build step
 * that silently never runs.
 *
 *   npx electron scripts/make-icons.js
 *
 * Writes build/icon.png (1024) plus smaller sizes. electron-builder picks up
 * build/icon.png automatically and derives .ico and .icns from it.
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'design', 'brand', 'app-icon.svg');
const OUT = path.join(ROOT, 'build');

const MASTER = 1024;
const DERIVED = [512, 256, 128, 64, 48, 32, 16];

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const svg = fs.readFileSync(SOURCE, 'utf8');
  const pageFile = path.join(OUT, '_render.html');
  fs.writeFileSync(pageFile, `<!DOCTYPE html><meta charset="utf-8">
    <style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${MASTER}px;height:${MASTER}px}
    </style>${svg}`, 'utf8');

  // One window, one load. Creating and destroying a window per size aborts the
  // next load with ERR_FAILED — the sizes are produced by resampling instead.
  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
  });

  await win.loadFile(pageFile);
  await new Promise((r) => setTimeout(r, 400));

  const master = await win.webContents.capturePage();
  const masterSize = master.getSize();
  if (masterSize.width !== MASTER) {
    console.log(`  WARN master rendered at ${masterSize.width}px, expected ${MASTER}`);
  }

  fs.writeFileSync(path.join(OUT, 'icon.png'), master.toPNG());
  console.log(`  ok   icon.png         ${masterSize.width}x${masterSize.height}`);

  // Resampled from the master rather than re-rendered per size. The app icon
  // is a rounded plate with a single mark on it — there is no hinting to lose,
  // unlike the UI mark, which has a purpose-drawn 16px variant precisely
  // because it does. See design/brand/README.md.
  for (const size of DERIVED) {
    const scaled = master.resize({ width: size, height: size, quality: 'best' });
    fs.writeFileSync(path.join(OUT, `icon-${size}.png`), scaled.toPNG());
    console.log(`  ok   icon-${String(size).padEnd(4)}.png    ${size}x${size}`);
  }

  writeIcns(master);

  win.destroy();
  fs.unlinkSync(pageFile);
  console.log(`\nicons in ${OUT}`);
  app.quit();
});

/**
 * Build `build/icon.icns` with Apple's own `iconutil`, rather than letting
 * electron-builder derive one from `icon.png`.
 *
 * This is not belt-and-braces, it fixes a visible bug. electron-builder's
 * generated `.icns` stores its small sizes in the `icp4`, `icp5` and `icp6`
 * chunk types. Those types are ambiguous — the format allows either PNG or raw
 * pixel data in them and there is no discriminator — and macOS 26 reads them as
 * raw. The result is that the correct 16px artwork is decoded as noise.
 *
 * Seen in System Settings → Privacy & Security → Screen & System Audio
 * Recording, where Handrail's row showed a block of coloured static next to its
 * name while the Dock and Finder, which use the larger chunks, looked right.
 * Extracting the `icp4` chunk and opening it confirmed the PNG inside was a
 * perfectly good icon: the file was fine, the container was wrong.
 *
 * `iconutil` never emits those types. It writes `ic11`/`ic12` for the small
 * Retina sizes and the legacy `is32`/`s8mk` pair for 16x16, which is what every
 * macOS actually agrees on. It ships with macOS, so this costs no dependency —
 * it just cannot run anywhere else, hence the platform guard. A non-mac build
 * machine keeps electron-builder's fallback, which is only wrong on macOS
 * anyway.
 */
function writeIcns(master) {
  if (process.platform !== 'darwin') {
    console.log('  skip icon.icns        (needs macOS iconutil)');
    return;
  }

  const { execFileSync } = require('child_process');
  const iconset = path.join(OUT, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });

  // The names are a fixed contract with iconutil — it derives the chunk type
  // from the filename, so these are not free-form.
  const VARIANTS = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of VARIANTS) {
    const image = size === MASTER ? master : master.resize({ width: size, height: size, quality: 'best' });
    fs.writeFileSync(path.join(iconset, name), image.toPNG());
  }

  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT, 'icon.icns')]);
    console.log('  ok   icon.icns        (iconutil, no ambiguous icp4/5/6 chunks)');
  } catch (err) {
    console.log(`  WARN iconutil failed: ${err.message}`);
  } finally {
    fs.rmSync(iconset, { recursive: true, force: true });
  }
}
