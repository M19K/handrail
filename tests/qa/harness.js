/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — QA harness.
 *
 * Launches the REAL app: `electron .`, through main.js, with the real store,
 * the real windows and the real preload. This is the thing `scripts/smoke.js`
 * cannot do — smoke constructs Store/Windows/TurnController by hand inside one
 * Electron process, so it never exercises boot, window lifecycle, the tray, the
 * global shortcuts, or what a user actually sees when the model call fails.
 *
 * Every launch gets its own throwaway userData directory. Without that a test
 * run would mutate the installed app's settings, threads and key, and results
 * would depend on the previous run.
 *
 * `playwright-core`, not `playwright` or `@playwright/test`: driving Electron
 * needs `_electron` and nothing else, and the full package downloads three
 * browsers on install that would then have to be downloaded in CI too.
 */

'use strict';

const { _electron } = require('playwright-core');
const electronPath = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(os.tmpdir(), 'handrail-qa');

/** A key that is well-formed but dead. Boot takes the overlay path; calls fail. */
const FAKE_KEY = `sk-or-v1-${'0'.repeat(64)}`;

/**
 * Launch Handrail.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withKey] seed a key, so boot opens the overlay rather
 *   than onboarding. Boot branches on `store.getKey()`, not on a settings flag.
 * @param {string}  [opts.userDataDir] reuse a directory, to test persistence
 *   across a restart.
 */
async function launchApp(opts = {}) {
  const userDataDir = opts.userDataDir
    || fs.mkdtempSync(path.join(os.tmpdir(), 'handrail-qa-data-'));

  const env = { ...process.env, HANDRAIL_QA: '1' };
  // `.env` is read by dotenv at boot and would otherwise leak the developer's
  // real key into the run — and, worse, make results depend on whether one
  // exists. Explicit either way.
  if (opts.withKey) env.OPENROUTER_API_KEY = FAKE_KEY;
  else delete env.OPENROUTER_API_KEY;

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [ROOT, `--user-data-dir=${userDataDir}`],
    env,
    cwd: ROOT,
    timeout: 60000,
  });

  app.__userDataDir = userDataDir;
  return app;
}

/**
 * The first window whose URL ends in `name`, once it has finished loading.
 *
 * Waiting on `app.firstWindow()` alone is not enough: Handrail can have an
 * overlay, an arrow and an onboarding window, and which one appears first
 * depends on whether a key was found.
 */
async function windowNamed(app, name, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      if (win.url().includes(name)) {
        await win.waitForLoadState('domcontentloaded');
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const urls = app.windows().map((w) => w.url());
  throw new Error(`no window matching "${name}" after ${timeoutMs}ms; open: ${JSON.stringify(urls)}`);
}

/** Collect renderer console errors from the moment this is called. */
function watchConsole(win) {
  const errors = [];
  win.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  win.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Read main-process state without adding a test-only IPC channel to the app. */
function inMain(app, fn, arg) {
  return app.evaluate(fn, arg);
}

async function shoot(win, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await win.screenshot({ path: file });
  return file;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function closeApp(app) {
  try { await app.close(); } catch (_) { /* already gone */ }
}

module.exports = { launchApp, windowNamed, watchConsole, inMain, shoot, wait, closeApp, ROOT, SHOTS, FAKE_KEY };
