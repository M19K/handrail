/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — does the built macOS app actually start?
 *
 *   node scripts/verify-mac-build.js [path/to/Handrail.app]
 *
 * Run this against the artifact, after `npm run build:mac`, before publishing.
 *
 * WHY THIS EXISTS
 *
 * Every other layer of verification runs against the REPO. `npm test` imports
 * source files, `scripts/smoke.js` runs `npx electron .`, and the Playwright
 * suite launches the same source tree. All three were green for 0.1.3 while the
 * shipped macOS `.dmg` could not open a window at all — because none of them
 * ever executed the packaged bundle.
 *
 * Two separate defects hid in that gap and both were invisible to a green
 * suite:
 *
 *   1. `build.files` did not ship the tray artwork, so the packaged app logged
 *      "no tray icon on disk" and — with LSUIElement removing the Dock icon —
 *      had no presence anywhere in the system.
 *
 *   2. ASAR integrity. electron-builder writes a header hash into Info.plist
 *      under `ElectronAsarIntegrity`; the Electron the app was pinned to
 *      validated it differently and rejected a CORRECT hash. Electron exited
 *      inside dyld before a line of JavaScript ran: no window, no log, no
 *      crash report, no stdout. The process just sat there.
 *
 * The check is deliberately dumb, and that is the point: launch the real
 * bundle, wait for the app to write its own log, and read it. An app that
 * cannot get far enough to write one line about itself is not shippable, and
 * this is the only test in the repo that can tell.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Long enough for a cold launch on a slow disk, short enough to fail fast. */
const BOOT_TIMEOUT_MS = 25000;

function fail(message) {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

/**
 * Leave nothing running and nothing on disk.
 *
 * This mattered more than it looks. The first version killed the process group
 * and hoped. Electron's helper processes are not always in it, so the app could
 * survive — and because this script launches with its own `--user-data-dir`, the
 * survivor did NOT collide with the single-instance lock of the app the user
 * actually installed. Both ran at once, on different stores: the real one with
 * the user's key showing the overlay, this one with an empty store showing
 * onboarding. Two windows, same app, contradicting each other.
 *
 * It also left a `handrail-verify-*` directory in the temp folder per run, and
 * — because launching a bundle registers it — put the two `dist/` builds into
 * LaunchServices and TCC alongside the installed one. Three apps with the same
 * bundle id and three different ad-hoc signatures is how a granted screen
 * recording permission stops applying to the app that asked for it.
 */
async function shutDown(binary, child, userData) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* already gone */ }

  // Everything launched from THIS bundle, helpers included. Matched on the full
  // executable path so a differently-located Handrail is never touched.
  try {
    execFileSync('pkill', ['-9', '-f', binary], { stdio: 'ignore' });
  } catch (_) { /* pkill exits non-zero when nothing matched, which is fine */ }

  // Give the kernel a moment, then confirm rather than assume.
  await new Promise((r) => setTimeout(r, 500));
  try {
    const left = execFileSync('pgrep', ['-f', binary], { stdio: 'pipe' }).toString().trim();
    if (left) console.log(`  WARN processes survived shutdown: ${left.split('\n').join(', ')}`);
  } catch (_) { /* pgrep exits non-zero when nothing is left, which is the good case */ }

  fs.rmSync(userData, { recursive: true, force: true });
}

function findApp() {
  if (process.argv[2]) return process.argv[2];
  // Prefer the architecture this machine can actually execute.
  const candidates = process.arch === 'arm64'
    ? ['dist/mac-arm64/Handrail.app', 'dist/mac/Handrail.app']
    : ['dist/mac/Handrail.app', 'dist/mac-arm64/Handrail.app'];
  const found = candidates.map((p) => path.join(__dirname, '..', p)).find((p) => fs.existsSync(p));
  if (!found) fail('no built app found — run `npm run build:mac` first');
  return found;
}

async function main() {
  const app = findApp();
  const binary = path.join(app, 'Contents', 'MacOS', 'Handrail');
  if (!fs.existsSync(binary)) fail(`no executable inside ${app}`);

  console.log(`verifying ${path.relative(path.join(__dirname, '..'), app)}`);

  // --- static checks, before spending time on a launch ---------------------

  const arch = execFileSync('file', [binary]).toString();
  console.log(`  arch: ${arch.includes('arm64') ? 'arm64' : 'x86_64'}`);

  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
    console.log('  signature: valid');
  } catch (err) {
    // A malformed signature is what makes Gatekeeper say "damaged and can't be
    // opened", which has no in-UI workaround at all.
    fail(`the bundle's signature does not verify: ${(err.stderr || '').toString().trim()}`);
  }

  for (const key of ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription']) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents', 'Info.plist')], { stdio: 'pipe' });
      fail(`${key} is still in Info.plist — Handrail does not use it`);
    } catch (_) { /* absent, which is correct */ }
  }
  console.log('  Info.plist: claims no unused hardware');

  // --- the launch ----------------------------------------------------------

  // A throwaway userData, so this never reads or destroys the real install —
  // and so the log being read is definitely from THIS run.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'handrail-verify-'));
  const logFile = path.join(userData, 'handrail.log');

  const child = spawn(binary, [`--user-data-dir=${userData}`], { stdio: 'ignore', detached: true });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let log = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(logFile)) {
      log = fs.readFileSync(logFile, 'utf8');
      // Wait for the line that proves boot got past window creation, not just
      // that the file was opened.
      if (/tray created|NO TRAY ICON/.test(log)) break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  await shutDown(binary, child, userData);

  if (!log) {
    fail(
      'the app never wrote a log line.\n' +
      '        It launched and then did nothing — the ASAR-integrity failure mode.\n' +
      `        Check ElectronAsarIntegrity in ${path.join(app, 'Contents', 'Info.plist')}\n` +
      '        against the Electron version in package.json.',
    );
  }

  if (/NO TRAY ICON/.test(log)) {
    fail(
      'the app started but found no tray icon.\n' +
      '        On macOS LSUIElement also removes the Dock icon, so the shipped app\n' +
      '        would have no visible presence at all. Check `build.files` ships assets/.',
    );
  }

  if (!/tray created/.test(log)) fail(`boot did not reach the tray. Log:\n${log}`);

  console.log('  launch: reached app-ready and created the tray');
  console.log('\n  PASS  the built app starts\n');
}

main().catch((err) => fail(err.stack || err.message));
