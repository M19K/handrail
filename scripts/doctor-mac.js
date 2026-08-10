#!/usr/bin/env node
/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — macOS environment check.
 *
 * Written after a debugging session lost about an hour to a problem that none
 * of the three test suites could see, because none of them look outside the
 * repo. Three copies of Handrail.app existed at once — the installed one plus
 * the two `dist/` build outputs — each with its own ad-hoc signature and all
 * three claiming `com.handrail.app`. macOS binds a Screen Recording grant to a
 * signature, so the permission the user granted kept applying to a bundle that
 * was not the one asking, and the switch in System Settings stayed on the whole
 * time. Separately, two instances ran at once against different stores, so the
 * overlay and onboarding were on screen together contradicting each other.
 *
 * Every check here is read-only and reports a fact, not a guess. Nothing is
 * fixed automatically: the remedies touch installed apps and system privacy
 * records, which is not something a script should do behind someone's back.
 *
 *   node scripts/doctor-mac.js          report, exit 0 unless something is wrong
 *   node scripts/doctor-mac.js --quiet  only print problems
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BUNDLE_ID = 'com.handrail.app';
const QUIET = process.argv.includes('--quiet');

const findings = [];
const note = (level, title, detail, fix) => findings.push({ level, title, detail, fix });

/**
 * Run a command and return its output, or '' if it failed or matched nothing.
 *
 * stderr is merged in deliberately: `codesign -d` writes everything it knows to
 * stderr, so discarding it made this report every bundle as unsigned.
 */
function run(cmd, args) {
  // spawnSync rather than execFileSync because both streams are wanted and
  // execFileSync returns stdout alone — which silently dropped every line
  // codesign writes and made a correctly signed app report as unsigned.
  // A non-zero exit is the ordinary "nothing matched" case here, not an error.
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

/**
 * Full command lines of every running process.
 *
 * macOS `pgrep` has no `-a`, so `pgrep -af x` silently returns bare pids rather
 * than failing. Parsing those for `--user-data-dir` found nothing, and this
 * check cheerfully reported "Not running" while the app was running — the exact
 * class of quiet wrong answer the doctor exists to catch.
 */
function processLines() {
  return run('ps', ['-Ao', 'pid=,command=']).split('\n').filter(Boolean);
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A'
  + '/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

/**
 * Is this bundle known to LaunchServices?
 *
 * Presence on disk is harmless; registration is what matters, because a
 * registered bundle is one macOS will hand a TCC identity to. `lsregister -dump`
 * is large, so this greps it once per call rather than parsing it.
 */
function isRegistered(bundlePath) {
  if (!fs.existsSync(LSREGISTER)) return false;
  const dump = run(LSREGISTER, ['-dump']);
  if (!dump) return false;
  return dump.includes(bundlePath);
}

// --- 1. how many Handrail.app bundles exist -------------------------------
//
// The one that bit us. `dist/mac` and `dist/mac-arm64` are ordinary build
// output, but launching one — which `verify:mac` does — registers it with
// LaunchServices and TCC under the same bundle id as the installed copy.

function checkBundles() {
  const candidates = [
    '/Applications/Handrail.app',
    path.join(os.homedir(), 'Applications', 'Handrail.app'),
    path.join(REPO, 'dist', 'mac', 'Handrail.app'),
    path.join(REPO, 'dist', 'mac-arm64', 'Handrail.app'),
  ].filter((p) => fs.existsSync(p));

  if (candidates.length === 0) {
    note('info', 'No Handrail.app installed', 'Nothing to check against.');
    return candidates;
  }

  // CDHash only appears at verbosity 4; -dv stops short of it.
  const signed = candidates.map((p) => {
    const out = run('codesign', ['-d', '--verbose=4', p]);
    const cd = /CDHash=([0-9a-f]+)/.exec(out);
    return { path: p, cdhash: cd ? cd[1].slice(0, 12) : 'no signature' };
  });

  // A bundle sitting in dist/ is ordinary build output. It only becomes the
  // problem once it is REGISTERED — launching one is what puts a second
  // signature under the same bundle id into LaunchServices and TCC. So the
  // severity depends on registration, not on presence: otherwise this fails
  // every single build, since electron-builder always writes dist/mac*.
  const installed = signed.filter((s) => !s.path.includes('/dist/'));
  const built = signed.filter((s) => s.path.includes('/dist/'));
  const registeredBuilt = built.filter((s) => isRegistered(s.path));

  if (installed.length > 1) {
    note('error', `${installed.length} installed copies of Handrail.app`,
      installed.map((s) => `${s.path}  (${s.cdhash})`).join('\n'),
      'Keep one and delete the rest. Each carries its own ad-hoc signature but\n'
      + '    the same bundle id, so a Screen Recording grant given to one silently\n'
      + '    does not apply to another.');
  } else if (registeredBuilt.length) {
    // WARN, not FAIL. LaunchServices indexes a bundle for merely existing in a
    // scanned location, and telling that apart from one that was launched and
    // actually holds a TCC grant needs TCC.db, which is unreadable without Full
    // Disk Access. Failing the build on an indexed-but-harmless bundle would
    // make `build:mac` fail every time and train everyone to ignore the check.
    note('warn', 'A dist/ build is known to LaunchServices',
      registeredBuilt.map((s) => `${s.path}  (${s.cdhash})`).join('\n'),
      'Harmless if it was only indexed; a problem if it was ever launched, since\n'
      + '    that puts a SECOND signature under the same bundle id as the installed\n'
      + '    app and a Screen Recording grant is keyed to the signature. To be sure:\n'
      + '    lsregister -u <path> && rm -rf dist/mac dist/mac-arm64');
  } else if (!QUIET) {
    if (installed.length) {
      note('ok', 'One installed Handrail.app',
        `${installed[0].path}  (${installed[0].cdhash})`);
    }
    if (built.length) {
      note('info', `${built.length} unregistered build output(s) in dist/`,
        built.map((s) => s.path).join('\n')
        + '\nOrdinary build output, not registered with LaunchServices.');
    }
  }
  return candidates;
}

// --- 2. how many instances are running ------------------------------------
//
// main.js sets `process.title = 'Handrail'`, so the main process does NOT show
// its executable path in ps and cannot be found by matching on one. The helper
// processes do keep their real paths, so they are what identifies which bundle
// an instance actually came from.

function checkInstances(bundles) {
  const helpers = processLines().filter((l) => l.includes('Handrail Helper'));

  const perBundle = new Map();
  for (const line of helpers) {
    const hit = bundles.find((b) => line.includes(b + '/Contents/'));
    const key = hit || 'unknown location';
    perBundle.set(key, (perBundle.get(key) || 0) + 1);
  }

  // Distinct user-data-dirs is the honest instance count: two instances of the
  // same bundle on different stores is exactly the state that put the overlay
  // and onboarding on screen at the same time.
  const stores = new Set();
  for (const line of helpers) {
    const m = /--user-data-dir=(\S+)/.exec(line);
    if (m) stores.add(m[1]);
  }

  if (stores.size > 1) {
    note('error', `${stores.size} Handrail instances running on different stores`,
      [...stores].join('\n    '),
      'Quit them all (pkill -f Handrail) and open only /Applications/Handrail.app.\n'
      + '    A second instance on its own --user-data-dir does NOT trip the\n'
      + '    single-instance lock, so both stay up and disagree about setup state.');
  } else if (perBundle.size > 1) {
    note('error', 'Instances running from more than one bundle',
      [...perBundle.keys()].join('\n    '),
      'Quit them all and open only the installed copy.');
  } else if (!QUIET) {
    const where = [...perBundle.keys()][0];
    note('ok', stores.size ? 'One instance running' : 'Not running',
      where ? String(where) : 'No Handrail processes.');
  }
}

// --- 3. leftover test directories -----------------------------------------
//
// smoke, qa and verify:mac each write a throwaway userData dir. They used to
// leave them behind, which is harmless but made it impossible to tell at a
// glance whether a stray instance had a store of its own.

function checkTempDirs() {
  const roots = [os.tmpdir(), '/tmp'];
  let count = 0;
  const seen = new Set();
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_) { continue; }
    for (const name of entries) {
      if (!/^handrail-/.test(name)) continue;
      const full = path.join(root, name);
      if (seen.has(full)) continue;
      seen.add(full);
      count += 1;
    }
  }
  if (count > 8) {
    note('warn', `${count} leftover handrail-* directories in the temp folder`,
      [...seen].slice(0, 3).join('\n    ') + (count > 3 ? `\n    …and ${count - 3} more` : ''),
      'Safe to delete: find "$TMPDIR" -maxdepth 1 -type d -name "handrail-*" -exec rm -rf {} +');
  } else if (!QUIET) {
    note('ok', 'Temp directories clean', `${count} handrail-* directories.`);
  }
}

// --- 4. screen recording, the permission the product cannot work without ---
//
// TCC.db is not readable without Full Disk Access, so this reports what CAN be
// established without it and says plainly which part it cannot see.

function checkScreenRecording(bundles) {
  if (!bundles.length) return;
  const installed = bundles.find((b) => b.startsWith('/Applications')) || bundles[0];
  const plist = path.join(installed, 'Contents', 'Info.plist');

  const usage = run('/usr/libexec/PlistBuddy',
    ['-c', 'Print :NSScreenCaptureUsageDescription', plist]);
  if (!usage) {
    note('error', 'No NSScreenCaptureUsageDescription in the installed app',
      plist,
      'macOS shows this string in the permission prompt. Without it the prompt\n'
      + '    can be suppressed entirely and capture fails with no explanation.');
  } else if (!QUIET) {
    note('ok', 'Screen capture usage string present', usage);
  }

  const agent = run('/usr/libexec/PlistBuddy', ['-c', 'Print :LSUIElement', plist]);
  if (!QUIET) {
    note('info', 'Runs as a menu bar agent', `LSUIElement = ${agent || 'not set'} `
      + '(no Dock icon, not in Cmd-Tab — by design).');
  }
}

// --- 5. the signature stability problem, stated plainly -------------------

function checkSigning(bundles) {
  if (!bundles.length) return;
  const installed = bundles.find((b) => b.startsWith('/Applications')) || bundles[0];
  const out = run('codesign', ['-dv', '--verbose=2', installed]);
  const team = /TeamIdentifier=(\S+)/.exec(out);

  if (!team || team[1] === 'not' || team[1] === 'not set') {
    note('warn', 'Installed app is ad-hoc signed, not Developer ID signed',
      'TeamIdentifier is not set.',
      'Expected for an unsigned build, and it is why every rebuild resets the\n'
      + '    Screen Recording grant: macOS keys that grant to the code signature,\n'
      + '    and an ad-hoc signature is unique per build. A Developer ID gives a\n'
      + '    stable signature across versions and ends this class of problem.');
  }
}

// --- report ---------------------------------------------------------------

function main() {
  if (process.platform !== 'darwin') {
    console.log('doctor-mac only applies to macOS.');
    return 0;
  }

  const bundles = checkBundles();
  checkInstances(bundles);
  checkTempDirs();
  checkScreenRecording(bundles);
  checkSigning(bundles);

  const mark = { ok: '  ok ', warn: 'WARN ', error: 'FAIL ', info: '  -- ' };
  console.log('\nHandrail — macOS environment\n');
  for (const f of findings) {
    console.log(`${mark[f.level]} ${f.title}`);
    if (f.detail) console.log(`    ${f.detail.split('\n').join('\n    ')}`);
    if (f.fix) console.log(`    fix: ${f.fix}`);
    console.log('');
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  console.log(errors ? `${errors} problem(s) found.` : 'Nothing out of place.');
  if (warns && !errors) console.log(`${warns} thing(s) worth knowing about.`);
  return errors ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
