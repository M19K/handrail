/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — does the built Windows app actually start?
 *
 *   node scripts/verify-win-build.js [path\to\Handrail.exe]
 *
 * Run this against the artifact, after `npm run build:win`, before publishing.
 *
 * WHY THIS EXISTS
 *
 * Because it already failed, on Windows, for six releases running.
 *
 * Every other layer of verification runs against the REPO. `npm test` imports
 * source files, `scripts/smoke.js` runs `npx electron .`, and the Playwright
 * suite launches the same source tree. On 2026-08-10 all three were green —
 * 132 unit tests, every smoke check, 29 Playwright tests — while the shipped
 * `Handrail-Setup-0.1.5.exe` started with **no tray icon at all**.
 *
 * The cause was pure packaging, which is exactly the class of fault no
 * repo-level test can see. `build.files` ships `assets/**`, and `assets/` held
 * only the macOS template artwork. The three places `main.js` looks for Windows
 * tray art — `assets/tray-32.png`, `build/icon-32.png`, `icon.ico` — were none
 * of them in the package. `scripts/package-win.js` copies those files by hand,
 * so every build made on the author's machine had a tray and the released one
 * never did. The local build passing is what hid it.
 *
 * On Windows a missing tray is not cosmetic. The overlay sets `skipTaskbar`, so
 * with no tray icon there is no way to reach Quit once the overlay is hidden,
 * and — until this same commit — no working panic hotkey either.
 *
 * The check is deliberately dumb, and that is the point: launch the real
 * executable, wait for the app to write its own log, and read it. An app that
 * cannot get far enough to write one line about itself is not shippable, and
 * this is the only test in the repo that can tell.
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Long enough for a cold launch on a slow disk, short enough to fail fast. */
const BOOT_TIMEOUT_MS = 30000;

const REPO = path.join(__dirname, '..');

function fail(message) {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

/**
 * Leave nothing running and nothing on disk.
 *
 * `taskkill /T` takes the whole tree, because Electron's GPU and utility
 * processes are children and killing only the parent leaves them holding the
 * user-data directory open — which then fails to delete, and leaves a
 * `handrail-verify-*` folder in %TEMP% per run.
 *
 * Matched on image name AND the executable path, so a Handrail the user
 * actually installed is never touched by a verification run.
 */
function shutDown(exe, child, userData) {
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_) { /* already gone */ }

  // Anything left from THIS executable specifically. wmic is gone on recent
  // Windows, so PowerShell is the portable way to match on path.
  try {
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Name Handrail -ErrorAction SilentlyContinue | `
      + `Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' } | `
      + 'Stop-Process -Force -ErrorAction SilentlyContinue',
    ], { stdio: 'ignore' });
  } catch (_) { /* best effort */ }

  // Give the kernel a moment to release the handles, then clean up.
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 800'], { stdio: 'ignore' });
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (_) {
    console.log(`  WARN could not remove ${userData}`);
  }
}

function findExe() {
  if (process.argv[2]) return process.argv[2];
  const candidates = [
    'dist/win-unpacked/Handrail.exe',        // electron-builder, what ships
    'dist/Handrail-win32-x64/Handrail.exe',  // scripts/package-win.js
  ];
  const found = candidates.map((p) => path.join(REPO, p)).find((p) => fs.existsSync(p));
  if (!found) fail('no built app found — run `npm run build:win` first');
  return found;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('verify-win-build only applies to Windows.');
    return;
  }

  const exe = findExe();
  console.log(`verifying ${path.relative(REPO, exe)}`);

  // --- static checks, before spending time on a launch ---------------------

  const resources = path.join(path.dirname(exe), 'resources');
  const asar = path.join(resources, 'app.asar');
  if (!fs.existsSync(asar) && !fs.existsSync(path.join(resources, 'app'))) {
    fail(`no app.asar or resources/app inside ${resources}`);
  }

  // The version Windows reports is what the user sees in Properties, and it is
  // how `doctor-win.js` tells builds apart. A build stamped with Electron's
  // version instead of Handrail's means the branding step did not run.
  const probe = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
  ], { encoding: 'utf8' });
  const stamped = (probe.stdout || '').trim();
  const expected = require(path.join(REPO, 'package.json')).version;
  if (!stamped) {
    console.log('  WARN could not read the executable version');
  } else if (!stamped.startsWith(expected)) {
    fail(
      `the executable reports version ${stamped}, but package.json says ${expected}.\n`
      + '        A build stamped with Electron\'s version has not been branded —\n'
      + '        users see the wrong version and doctor-win cannot tell builds apart.',
    );
  } else {
    console.log(`  version: ${stamped}`);
  }

  // --- the launch ----------------------------------------------------------

  // A throwaway userData, so this never reads or destroys the real install —
  // and so the log being read is definitely from THIS run.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'handrail-verify-'));
  const logFile = path.join(userData, 'handrail.log');

  /**
   * Windows 11 Smart App Control can refuse to start this outright.
   *
   * SAC (`VerifiedAndReputablePolicyState = 1`) blocks unsigned binaries that
   * have no reputation, and a binary electron-builder wrote thirty seconds ago
   * has none. Node surfaces that refusal as `spawn UNKNOWN`, which reads like a
   * bug in this script rather than a policy decision by the OS.
   *
   * Observed on the author's machine: SAC blocks `dist/win-unpacked/Handrail.exe`
   * but allows the NSIS installer built from it in the same run.
   *
   * This must NOT quietly pass. A check that cannot run is the exact failure
   * this whole script exists to prevent — so it is a loud warning locally,
   * where the developer can see it and reach for CI, and a hard failure in CI,
   * where nothing should ever block a launch and being unable to launch means
   * the artifact is broken.
   */
  let child;
  try {
    child = spawn(exe, [`--user-data-dir=${userData}`], { stdio: 'ignore', detached: true });
    child.unref();
  } catch (err) {
    fs.rmSync(userData, { recursive: true, force: true });
    const blocked = err.code === 'UNKNOWN' || /Application Control|blocked/i.test(err.message || '');
    if (blocked && !process.env.CI) {
      console.log('\n  WARN  this machine will not launch the build, so it was NOT verified.');
      console.log('        Windows Smart App Control blocks freshly built unsigned binaries.');
      console.log('        Check it with: npm run doctor');
      console.log('        CI has no such policy and verifies every release — trust that, not this.\n');
      return;
    }
    fail(
      `could not launch the build: ${err.message}\n`
      + (blocked
        ? '        Windows refused to run it under an Application Control policy.'
        : '        The executable exists but the OS would not start it.'),
    );
  }

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let log = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(logFile)) {
      log = fs.readFileSync(logFile, 'utf8');
      // Wait for the line that proves boot reached the tray, not just that the
      // file was opened.
      if (/tray created|NO TRAY ICON/.test(log)) break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  shutDown(exe, child, userData);

  if (!log) {
    fail(
      'the app never wrote a log line.\n'
      + '        It launched and then did nothing. Check that main.js is in build.files\n'
      + '        and that the asar is not corrupt.',
    );
  }

  if (/NO TRAY ICON/.test(log)) {
    fail(
      'the app started but found no tray icon.\n'
      + '        The overlay sets skipTaskbar, so with no tray there is no way to reach\n'
      + '        Quit once it is hidden. This shipped in 0.1.0 through 0.1.5.\n'
      + '        Fix: `assets/tray-16.png` and `assets/tray-32.png` must exist and\n'
      + '        `assets/**/*` must be in build.files. Run `npm run tray-icons`.',
    );
  }

  if (!/tray created/.test(log)) fail(`boot did not reach the tray. Log:\n${log}`);

  // The panic key is the one that gets Handrail off a shared screen. It failing
  // is survivable, but it must never fail silently again — 0.1.0 to 0.1.5 asked
  // Windows for Ctrl+Shift+Escape, which is Task Manager, and ignored the "no".
  if (/PANIC KEY UNAVAILABLE/.test(log)) {
    fail(
      'the panic hotkey did not register.\n'
      + '        Another app or the OS holds it. Pick a different combination in\n'
      + '        main.js registerShortcuts().',
    );
  }
  if (!/shortcuts:/.test(log)) {
    console.log('  WARN the log does not confirm the shortcuts registered');
  } else {
    console.log(`  ${log.split('\n').find((l) => l.includes('shortcuts:')).replace(/^\S+\s+/, '').trim()}`);
  }

  console.log('  launch: reached app-ready and created the tray');
  console.log('\n  PASS  the built app starts\n');
}

main().catch((err) => fail(err.stack || err.message));
