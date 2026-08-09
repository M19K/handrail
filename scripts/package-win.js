/**
 * Handrail — Windows packaging, without electron-builder.
 *
 * electron-builder cannot run on this machine: extracting its winCodeSign
 * toolchain creates symlinks, and Windows refuses that without Developer Mode
 * or elevation. Rather than change a system setting to get a build, this does
 * the packaging directly — which for an unsigned app is not much:
 *
 *   1. copy the prebuilt Electron runtime
 *   2. copy the app into resources/app
 *   3. rename electron.exe and stamp its icon and version info with rcedit
 *   4. write a .ico from the PNGs made by make-icons.js
 *
 * Produces an unsigned, portable build. Windows SmartScreen will warn on first
 * run; that is expected for any unsigned app and is not something packaging can
 * fix — it needs a certificate.
 *
 *   npx electron scripts/package-win.js           build only
 *   npx electron scripts/package-win.js --install  also install + desktop shortcut
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(ROOT, 'dist', 'Handrail-win32-x64');
const APP = path.join(OUT, 'resources', 'app');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const INSTALL = process.argv.includes('--install');

// ---------------------------------------------------------------------------
// .ico
// ---------------------------------------------------------------------------

/**
 * Write a Windows .ico from PNG files.
 *
 * The format is simple enough that a dependency is not worth it: a 6-byte
 * header, a 16-byte directory entry per image, then the image data. Vista and
 * later accept PNG-compressed entries directly, so the PNGs go in untouched.
 */
function writeIco(pngPaths, target) {
  const images = pngPaths.map((file) => {
    const data = fs.readFileSync(file);
    // Dimensions live at bytes 16-24 of a PNG's IHDR chunk.
    return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, i) => {
    const at = i * 16;
    // 256 is stored as 0 — the field is one byte and 256 does not fit.
    directory.writeUInt8(image.width >= 256 ? 0 : image.width, at + 0);
    directory.writeUInt8(image.height >= 256 ? 0 : image.height, at + 1);
    directory.writeUInt8(0, at + 2);       // palette size (0 = truecolour)
    directory.writeUInt8(0, at + 3);       // reserved
    directory.writeUInt16LE(1, at + 4);    // colour planes
    directory.writeUInt16LE(32, at + 6);   // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  fs.writeFileSync(target, Buffer.concat([header, directory, ...images.map((i) => i.data)]));
  return target;
}

// ---------------------------------------------------------------------------
// copying
// ---------------------------------------------------------------------------

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skip(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dst, skip);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
    // Symlinks are skipped deliberately — copying them is the exact thing that
    // breaks electron-builder here.
  }
}

function size(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += size(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build() {
  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(electronDist)) {
    throw new Error('node_modules/electron/dist missing — run npm install');
  }
  if (!fs.existsSync(path.join(BUILD, 'icon.png'))) {
    throw new Error('build/icon.png missing — run: npx electron scripts/make-icons.js');
  }

  console.log('cleaning');
  fs.rmSync(OUT, { recursive: true, force: true });

  console.log('copying electron runtime');
  copyDir(electronDist, OUT);

  // The default app that ships with the Electron runtime would take over if
  // resources/app were missing or broken. Removing it turns a packaging mistake
  // into a visible failure instead of Electron's "no app loaded" placeholder.
  fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

  console.log('copying app');
  fs.mkdirSync(APP, { recursive: true });

  for (const file of ['main.js', 'preload.js', 'preload-arrow.js', 'LICENSE', 'README.md']) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(APP, file));
  }

  // Tests are excluded; the mock bridge is not. It self-disables the moment the
  // real preload is present, and shipping the same bytes that were tested is
  // worth more than saving six kilobytes.
  copyDir(path.join(ROOT, 'src'), path.join(APP, 'src'), (_p, e) => e.name.endsWith('.test.js'));
  copyDir(path.join(ROOT, 'renderer'), path.join(APP, 'renderer'), (_p, e) => e.name === 'dev.js');
  copyDir(path.join(ROOT, 'design', 'brand'), path.join(APP, 'design', 'brand'));
  fs.mkdirSync(path.join(APP, 'design'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'design', 'tokens.css'), path.join(APP, 'design', 'tokens.css'));

  // dotenv is the only runtime dependency that is actually required, and it has
  // no dependencies of its own.
  copyDir(path.join(ROOT, 'node_modules', 'dotenv'), path.join(APP, 'node_modules', 'dotenv'));

  // A trimmed manifest. The build config and devDependencies are noise inside a
  // packaged app, and `main` is the only field Electron needs.
  fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
    name: pkg.name,
    productName: 'Handrail',
    version: pkg.version,
    description: pkg.description,
    main: 'main.js',
    author: pkg.author,
    license: pkg.license,
    dependencies: { dotenv: pkg.dependencies.dotenv },
  }, null, 2));

  console.log('writing icon');
  const icoSources = [16, 32, 48, 64, 128, 256]
    .map((s) => path.join(BUILD, `icon-${s}.png`))
    .filter(fs.existsSync);
  const ico = writeIco(icoSources, path.join(BUILD, 'icon.ico'));
  fs.copyFileSync(ico, path.join(APP, 'icon.ico'));

  console.log('branding executable');
  const exe = path.join(OUT, 'Handrail.exe');
  fs.renameSync(path.join(OUT, 'electron.exe'), exe);

  // rcedit ships inside electron-builder's cache. Stamping the icon and version
  // strings is what stops the app showing up in the taskbar as "Electron".
  const rcedit = findRcedit();
  if (rcedit) {
    execFileSync(rcedit, [exe,
      '--set-icon', ico,
      '--set-file-version', pkg.version,
      '--set-product-version', pkg.version,
      '--set-version-string', 'ProductName', 'Handrail',
      // Task Manager's "Name" column shows FileDescription, not ProductName.
      // Putting the tagline here listed the app — and all four of its helper
      // processes — as "A desktop overlay that sees yo…".
      '--set-version-string', 'FileDescription', 'Handrail',
      '--set-version-string', 'CompanyName', String((pkg.author && pkg.author.name) || 'Handrail'),
      '--set-version-string', 'LegalCopyright', 'Apache-2.0',
      '--set-version-string', 'OriginalFilename', 'Handrail.exe',
    ], { stdio: 'pipe' });
    console.log('  icon and version info stamped');
  } else {
    console.log('  WARN rcedit not found — the exe will keep the Electron icon');
  }

  console.log(`\nbuilt  ${OUT}`);
  console.log(`size   ${(size(OUT) / 1024 / 1024).toFixed(0)} MB`);
  return exe;
}

/** rcedit lives in electron-builder's cache, which is already populated. */
function findRcedit() {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache)) {
    const candidate = path.join(cache, dir, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Install to the per-user programs directory and put a shortcut on the desktop.
 *
 * %LOCALAPPDATA%\Programs is where user-scoped Windows apps belong, and it
 * needs no elevation. Installing there rather than shortcutting into the repo
 * means the shortcut survives the source tree being moved or deleted.
 */
function install(builtExe) {
  const target = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Handrail');
  console.log(`\ninstalling to ${target}`);

  fs.rmSync(target, { recursive: true, force: true });
  copyDir(OUT, target);

  const exe = path.join(target, 'Handrail.exe');
  const desktop = path.join(os.homedir(), 'Desktop');
  const link = path.join(desktop, 'Handrail.lnk');

  // WScript.Shell is the only reliable way to author a .lnk without a native
  // module. Paths are passed as PowerShell literals, not interpolated into a
  // command line.
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut('${link.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${exe.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${target.replace(/'/g, "''")}'`,
    `$s.IconLocation = '${exe.replace(/'/g, "''")},0'`,
    "$s.Description = 'Handrail — guided help for the software you are using'",
    '$s.Save()',
  ].join('; ');

  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe' });

  console.log(`shortcut  ${link}`);
  return { target, exe, link };
}

// ---------------------------------------------------------------------------

try {
  const exe = build();
  if (INSTALL) {
    const result = install(exe);
    console.log('\ndone. To remove:');
    console.log(`  del "${result.link}"`);
    console.log(`  rmdir /s /q "${result.target}"`);
  } else {
    console.log('\nrun with --install to install and add a desktop shortcut');
  }
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
}
