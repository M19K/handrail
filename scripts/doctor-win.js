#!/usr/bin/env node
/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — Windows environment check.
 *
 * The Windows counterpart to `doctor-mac.js`, written after the same class of
 * problem turned up here: on 2026-08-10 this machine had THREE launchable
 * Handrail.exe on it — the installed one plus two leftover `dist/` builds — and
 * the desktop shortcut pointed at a copy three releases old. Nothing in the
 * repo could see any of that, because nothing in the repo looks outside it.
 *
 * Windows is luckier than macOS here. There is no code-signature-scoped
 * permission to lose, so a stale copy is a confusion problem rather than a
 * broken-permissions problem: you debug the app you are not running. That still
 * cost real time.
 *
 * Every check is read-only and reports a fact, not a guess. Nothing is fixed
 * automatically — the remedies delete installed software, which is not
 * something a script should do behind someone's back.
 *
 *   node scripts/doctor-win.js          report, exit 1 if something is wrong
 *   node scripts/doctor-win.js --quiet  only print problems
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

const findings = [];
const note = (level, title, detail, fix) => findings.push({ level, title, detail, fix });

/** Run PowerShell and return trimmed stdout, or '' on any failure. */
function ps(command) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim();
}

/** What Windows reports as the file's product version, or '' if unreadable. */
function versionOf(exe) {
  return ps(`(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
}

/**
 * Every launchable Handrail.exe this machine can offer the user.
 *
 * Deliberately includes build output. A `dist\\win-unpacked\\Handrail.exe` is as
 * double-clickable as an installed one, it sits in a folder the user browses,
 * and Windows Search indexes it — so "I ran Handrail and my fix wasn't there"
 * has a second explanation nobody thinks of.
 */
function findInstallations() {
  const roots = [
    { path: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Handrail'), kind: 'installed' },
    { path: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Handrail'), kind: 'installed (per-machine)' },
    { path: path.join(REPO, 'dist', 'win-unpacked'), kind: 'build output (electron-builder)' },
    { path: path.join(REPO, 'dist', 'Handrail-win32-x64'), kind: 'build output (package-win.js)' },
  ];

  const found = [];
  for (const root of roots) {
    const exe = path.join(root.path, 'Handrail.exe');
    if (fs.existsSync(exe)) found.push({ ...root, exe, version: versionOf(exe) });
  }
  return found;
}

function checkInstallations(installs) {
  if (!installs.length) {
    note('ok', 'No Handrail installed', 'Nothing to be confused by.');
    return;
  }

  const real = installs.filter((i) => i.kind.startsWith('installed'));
  const leftovers = installs.filter((i) => !i.kind.startsWith('installed'));

  const list = installs
    .map((i) => `${i.exe}\n  ${i.kind}, reports version ${i.version || 'unknown'}`)
    .join('\n');

  if (installs.length === 1) {
    note('ok', 'Exactly one Handrail on this machine', list);
  } else {
    note(
      'error',
      `${installs.length} launchable copies of Handrail on this machine`,
      `${list}\n\nOnly one should be launchable. Every extra one is a chance to run — `
      + 'and then debug — a build that is not the one you changed.',
      leftovers.length
        ? `remove the build output: rimraf ${leftovers.map((l) => path.relative(REPO, path.dirname(l.exe))).join(' ')}`
        : 'uninstall the copies you do not want from Settings → Apps',
    );
  }

  if (real.length > 1) {
    note('error', 'More than one INSTALLED Handrail',
      real.map((i) => i.exe).join('\n'),
      'uninstall from Settings → Apps, then reinstall once');
  }

  // Version drift. Different versions in different places is the state that
  // produces "I fixed that already" while looking at an app that predates it.
  const versions = [...new Set(installs.map((i) => i.version).filter(Boolean))];
  if (versions.length > 1) {
    note('warn', 'The copies are different versions', `found: ${versions.join(', ')}`,
      'rebuild and reinstall so they agree, or delete the stale ones');
  }

  // The version the repo currently is, versus what is actually installed.
  const repoVersion = require(path.join(REPO, 'package.json')).version;
  for (const i of real) {
    if (i.version && !i.version.startsWith(repoVersion)) {
      note('warn', 'The installed Handrail is not the version in this repo',
        `installed ${i.version}, repo is ${repoVersion}`,
        'node scripts/package-win.js --install');
    }
  }
}

/** More than one running instance means two stores disagreeing on screen. */
function checkInstances() {
  const raw = ps(
    'Get-Process -Name Handrail -ErrorAction SilentlyContinue | '
    + 'ForEach-Object { "$($_.Id)`t$($_.Path)" }',
  );
  const lines = raw ? raw.split(/\r?\n/).filter(Boolean) : [];

  if (!lines.length) {
    note('ok', 'Handrail is not running', '');
    return;
  }

  const paths = [...new Set(lines.map((l) => l.split('\t')[1]).filter(Boolean))];
  // Electron spawns GPU and utility children under the same image name, so a
  // count of processes is meaningless. Distinct executable PATHS is the signal.
  if (paths.length > 1) {
    note('error', 'Two different Handrail builds are running at once',
      paths.join('\n'),
      'close them all, then start only the one you mean to test');
  } else {
    note('ok', 'One Handrail build running', paths[0] || '');
  }
}

/** Where the desktop shortcut actually points. */
function checkShortcut() {
  const lnk = path.join(os.homedir(), 'Desktop', 'Handrail.lnk');
  if (!fs.existsSync(lnk)) {
    note('ok', 'No desktop shortcut', '');
    return;
  }
  const target = ps(
    `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`,
  );
  if (!target) {
    note('warn', 'Desktop shortcut target could not be read', lnk);
    return;
  }
  if (!fs.existsSync(target)) {
    note('error', 'The desktop shortcut points at something that is gone', target,
      'delete the shortcut, or reinstall');
    return;
  }
  const inDist = path.resolve(target).startsWith(path.resolve(path.join(REPO, 'dist')));
  if (inDist) {
    note('error', 'The desktop shortcut points at build output, not an installed app', target,
      'node scripts/package-win.js --install');
  } else {
    note('ok', 'Desktop shortcut points at the installed app', `${target}  (v${versionOf(target) || '?'})`);
  }
}

/** The tray artwork the packaged app needs, present in the repo. */
function checkTrayArt() {
  const missing = ['tray-16.png', 'tray-32.png']
    .filter((f) => !fs.existsSync(path.join(REPO, 'assets', f)));
  if (missing.length) {
    note('error', 'Windows tray artwork is missing from assets/',
      `absent: ${missing.join(', ')}\n`
      + 'build.files ships assets/**, and nothing else it needs is shipped — so a\n'
      + 'release built without these has no tray icon at all. That shipped in\n'
      + '0.1.0 through 0.1.5 and nobody noticed, because package-win.js copies\n'
      + 'the files by hand and every local build therefore worked.',
      'npm run tray-icons');
  } else {
    note('ok', 'Windows tray artwork is in assets/', 'tray-16.png, tray-32.png');
  }
}

/**
 * Windows 11 Smart App Control.
 *
 * Enforced, it refuses to start unsigned binaries with no reputation. This is
 * NOT SmartScreen: there is no "More info → Run anyway", so a user who has it
 * on can be stopped with no way through at all.
 *
 * Which binary it blocks is NOT predictable. Observed on the author's machine,
 * all in one session:
 *   - the DOWNLOADED published `Handrail-Setup-0.1.6.exe`  BLOCKED
 *   - the DOWNLOADED published `Handrail.0.1.6.exe` portable  allowed
 *   - a locally built NSIS installer  allowed
 *   - a locally built `dist\\win-unpacked\\Handrail.exe`  BLOCKED
 *
 * It is not Mark-of-the-Web — none of those files carried one, and
 * `Unblock-File` changed nothing. So do not tell users "use the installer" or
 * "use the portable": either can be refused. Signing is the only real answer.
 */
function checkAppControl() {
  const state = ps(
    "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' "
    + '-ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState',
  );
  if (state === '1') {
    note('warn', 'Smart App Control is enforced on this machine',
      'It can refuse to start any unsigned Handrail build, with no "Run anyway".\n'
      + 'Which one it blocks is not predictable — the downloaded installer and a\n'
      + 'locally built unpacked exe were both refused here while the downloaded\n'
      + 'portable ran. `npm run verify:win` may therefore be unable to launch a\n'
      + 'local build. CI has no such policy and verifies every release there.',
      'the only real fix is code signing; turning SAC off is a one-way change '
      + 'in Windows Security → App & browser control');
  } else if (state === '2') {
    note('warn', 'Smart App Control is in evaluation mode', 'It may start blocking unsigned builds.');
  } else {
    note('ok', 'Smart App Control is not enforcing', '');
  }
}

/** Leftover verification temp directories. */
function checkTempDirs() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(os.tmpdir()).filter((d) => /^handrail-(verify|smoke)/.test(d));
  } catch (_) { /* unreadable temp is not this script's problem */ }

  if (dirs.length > 3) {
    note('warn', `${dirs.length} leftover Handrail temp directories`,
      `in ${os.tmpdir()}`,
      'safe to delete; they are throwaway user-data directories from test runs');
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('doctor-win only applies to Windows.');
    return 0;
  }

  const installs = findInstallations();
  checkInstallations(installs);
  checkInstances();
  checkShortcut();
  checkTrayArt();
  checkAppControl();
  checkTempDirs();

  const mark = { ok: '  ok  ', warn: ' warn ', error: ' FAIL ' };
  const shown = QUIET ? findings.filter((f) => f.level !== 'ok') : findings;

  console.log('\nHandrail — Windows environment\n');
  for (const f of shown) {
    console.log(`${mark[f.level]} ${f.title}`);
    if (f.detail) console.log(`    ${f.detail.split('\n').join('\n    ')}`);
    if (f.fix) console.log(`    fix: ${f.fix}`);
    console.log('');
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  console.log(errors ? `${errors} problem(s) found.` : 'Nothing out of place.');
  if (warns && !errors) console.log(`${warns} thing(s) worth knowing about.`);
  console.log('');

  return errors ? 1 : 0;
}

if (require.main === module) process.exit(main());
