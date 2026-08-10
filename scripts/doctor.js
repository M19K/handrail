#!/usr/bin/env node
/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — run the environment check for whichever platform this is.
 *
 * `npm run doctor` is in CLAUDE.md as the thing to run, and it used to be
 * hard-wired to the macOS one. On Windows that printed "doctor-mac only applies
 * to macOS" and exited 0 — a check that always passes is worse than no check,
 * because it reads as a clean bill of health.
 *
 * Arguments are passed through, so `npm run doctor -- --quiet` works on both.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const script = process.platform === 'darwin' ? 'doctor-mac.js' : 'doctor-win.js';

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.log(`No environment check for ${process.platform} — Handrail ships macOS and Windows.`);
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [path.join(__dirname, script), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

process.exit(result.status === null ? 1 : result.status);
