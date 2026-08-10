/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — electron-builder `beforePack` hook: stamp a unique build id.
 *
 * Writes `assets/build-id.txt` so it gets packed into the asar. `store.js` uses
 * it to answer one question: "did THIS build save the stored API key?"
 *
 * WHY A VERSION NUMBER IS NOT ENOUGH
 *
 * On macOS the `safeStorage` secret is a Keychain item whose ACL is bound to
 * the app's CODE SIGNATURE. Handrail is signed ad-hoc, and an ad-hoc signature
 * is unique per build — so two builds of the *same version* are still different
 * owners as far as the Keychain is concerned.
 *
 * The first version of this guard fingerprinted the build as
 * `app-<version>`, which correctly separated a dev run from a packaged one, and
 * one release from the next. It did not separate two builds of 0.1.4 — and that
 * gap showed up immediately: a rebuilt 0.1.4 reading a key saved by an earlier
 * 0.1.4 believed it was the owner, called into the Keychain, and macOS put up a
 * password prompt. Which is the failure the whole guard exists to prevent, since
 * that prompt is what blocks the main process at boot.
 *
 * A build id closes it exactly: same build, same id; any rebuild, new id.
 *
 * Not derived from the signature itself, deliberately — reading the real cdhash
 * means spawning `codesign` during boot, on the critical path, to answer a
 * question a stamped file already answers for free.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

exports.default = async function beforePack(context) {
  const dir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(dir, { recursive: true });

  // Random rather than a timestamp: two builds inside the same second are
  // different builds, and a clock is not a reliable way to say so.
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(dir, 'build-id.txt'), id, 'utf8');

  console.log(`[beforepack] build id ${id} (${context.electronPlatformName})`);
};
