/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — electron-builder `afterPack` hook for macOS.
 *
 * Two jobs, both of which decide whether a real person can open the app at all.
 *
 * ---------------------------------------------------------------------------
 * 1. Give the bundle a VALID ad-hoc signature
 * ---------------------------------------------------------------------------
 *
 * There is a difference between "unsigned" and "broken", and Gatekeeper treats
 * them nothing alike:
 *
 *   valid signature, unknown developer
 *       "Apple could not verify ... is free of malware."
 *       The user can right-click -> Open, or use Privacy & Security ->
 *       "Open Anyway". Both work. Annoying, survivable, documentable.
 *
 *   malformed signature
 *       ""Handrail" is damaged and can't be opened. You should move it to
 *       the Trash."   Buttons: Move to Trash | Cancel.
 *       There is no Open. Right-click -> Open shows the SAME dialog. No
 *       "Open Anyway" row ever appears in Privacy & Security, because that row
 *       is only offered for the unknown-developer verdict. The only way in is
 *       `xattr -cr` in Terminal.
 *
 * Handrail 0.1.3 shipped the second one. Verified on 2026-08-09 against the
 * published `Handrail-0.1.3-arm64.dmg`: `codesign` reported `Signature=adhoc`,
 * `linker-signed`, `Sealed Resources=none`, `Identifier=Electron`, and `spctl`
 * refused it with "code has no resources but signature indicates they must be
 * present". electron-builder had never signed it at all — what was there was
 * the linker's own stub, which does not cover the bundle's resources.
 *
 * Signing ad-hoc costs nothing, needs no Apple account, and moves the product
 * from "impossible to install" to "installable with two documented clicks".
 * It is not a substitute for Developer ID + notarisation, which is still the
 * only way to get a clean double-click. It is what to do until that exists.
 *
 * Order matters: nested code first, bundle last. A bundle signed before its
 * own frameworks seals hashes that then change underneath it, which produces
 * exactly the malformed state this is here to prevent.
 *
 * ---------------------------------------------------------------------------
 * 2. Strip Electron's placeholder privacy strings
 * ---------------------------------------------------------------------------
 *
 * Electron's stock Info.plist carries `NSMicrophoneUsageDescription` = "This
 * app needs access to the microphone" and the camera equivalent. Handrail cut
 * speech from v1 and has never used the camera, so shipping those declares
 * intent to access hardware the product does not touch — and the string macOS
 * would show is boilerplate written by somebody else.
 *
 * `extendInfo` in package.json can add keys but not remove them, so they are
 * deleted here.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** Privacy keys Electron ships by default that Handrail must not claim. */
const UNUSED_PRIVACY_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSCameraUsageDescription',
];

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function stripPlaceholderPrivacyStrings(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  for (const key of UNUSED_PRIVACY_KEYS) {
    try {
      run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
    } catch (_) {
      continue; // not present, nothing to do
    }
    run('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist]);
    console.log(`  removed ${key} (Handrail does not use it)`);
  }
}

/** The first four bytes of every Mach-O flavour, including fat binaries. */
const MACHO_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(head.readUInt32BE(0));
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Every signable thing in the bundle, in the order `codesign` demands.
 *
 * Signing is strictly inside-out. A container seals hashes of its contents, so
 * anything signed after its container invalidates that container — which is how
 * a bundle ends up "damaged" rather than merely unsigned.
 *
 * The first build attempt got this wrong by only walking the top of
 * `Contents/Frameworks`. `codesign` refused the Electron framework outright:
 * "code object is not signed at all — in subcomponent: .../Versions/A/Helpers/
 * chrome_crashpad_handler". There is signable code several levels down, so the
 * walk has to find it rather than assume a layout.
 *
 * Discovery is by Mach-O magic rather than by filename. Electron moves these
 * around between versions, and a hard-coded list of helper names is a list that
 * silently stops matching after an upgrade — producing a broken bundle that
 * builds cleanly, which is the exact failure mode being fixed here.
 */
function signTargets(appPath) {
  const machO = [];
  const bundles = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // a framework's Current/ etc — the real path is walked anyway
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) bundles.push(full);
        walk(full);
      } else if (entry.isFile() && isMachO(full)) {
        machO.push(full);
      }
    }
  }(appPath));

  // Deepest first, so nothing is ever sealed before the code inside it.
  const byDepth = (a, b) => b.split(path.sep).length - a.split(path.sep).length;

  // A framework is signed at its versioned directory, not at the .framework
  // path — that is what Apple's own tooling does and what verification expects.
  const bundleTargets = bundles.sort(byDepth).map((b) => {
    const versioned = path.join(b, 'Versions', 'A');
    return b.endsWith('.framework') && fs.existsSync(versioned) ? versioned : b;
  });

  // Loose binaries, then the bundles that contain them, then the app itself.
  return [...machO.sort(byDepth), ...bundleTargets, appPath];
}

function signAdHoc(target) {
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', target]);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterpack-mac] ${path.basename(appPath)}`);

  stripPlaceholderPrivacyStrings(appPath);

  const targets = signTargets(appPath);
  for (const target of targets) signAdHoc(target);
  console.log(`  ad-hoc signed ${targets.length} nested items, bundle last`);

  /**
   * Verify, and FAIL THE BUILD if it did not take.
   *
   * The whole point is that a bad signature is worse than none, and 0.1.3
   * proved a broken bundle can be produced, uploaded and published with
   * nobody noticing until someone tries to open it on a Mac. A build that
   * cannot be installed should not become a release artifact.
   */
  try {
    run('codesign', ['--verify', '--deep', '--strict', appPath]);
  } catch (err) {
    const detail = (err.stderr || err.stdout || '').toString().trim();
    throw new Error(
      `[afterpack-mac] the signed bundle does not verify: ${detail}\n` +
      'Shipping this would reproduce the "damaged and can\'t be opened" bug. Build stopped.',
    );
  }

  console.log('[afterpack-mac] ad-hoc signature applied and verified');
};
