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

  win.destroy();
  fs.unlinkSync(pageFile);
  console.log(`\nicons in ${OUT}`);
  app.quit();
});
