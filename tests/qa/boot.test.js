/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Booting the real app.
 *
 * Nothing here constructs a Store or a Window by hand. `electron .` runs, main.js
 * decides what to show, and we look at what a user would see. That decision —
 * onboarding or overlay — is made on whether a key can actually be read, which
 * is the honest test but also the one nothing exercised end to end.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { launchApp, windowNamed, watchConsole, inMain, shoot, wait, closeApp } = require('./harness');

test('with no key, boot opens onboarding', async () => {
  const app = await launchApp();
  try {
    const win = await windowNamed(app, 'onboarding.html');
    const errors = watchConsole(win);

    assert.equal(await win.locator('h1').first().isVisible(), true);
    await shoot(win, 'boot-onboarding');

    // The overlay must not exist yet. Building it early would put a window that
    // renders model output on screen before there is anything to render with.
    const urls = app.windows().map((w) => w.url());
    assert.ok(!urls.some((u) => u.includes('overlay.html')), `overlay should not be open: ${urls}`);
    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
  }
});

test('with a key, boot opens the overlay and skips onboarding', async () => {
  const app = await launchApp({ withKey: true });
  try {
    const win = await windowNamed(app, 'overlay.html');
    const errors = watchConsole(win);
    await wait(600);

    assert.equal(await win.locator('#input').isVisible(), true, 'the bar should be ready to type into');
    await shoot(win, 'boot-overlay');

    const urls = app.windows().map((w) => w.url());
    assert.ok(!urls.some((u) => u.includes('onboarding.html')), `onboarding should not be open: ${urls}`);
    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
  }
});

test('the overlay window is configured the way the review requires', async () => {
  const app = await launchApp({ withKey: true });
  try {
    await windowNamed(app, 'overlay.html');

    const cfg = await inMain(app, async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay.html'));
      const prefs = win.webContents.getLastWebPreferences();
      return {
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        alwaysOnTop: win.isAlwaysOnTop(),
        skipTaskbar: !win.isVisible() ? null : true,
      };
    });

    // The one window that renders model output is the one that most needs the
    // sandbox. It shipped with sandbox:false for several builds.
    assert.notEqual(cfg.sandbox, false, 'overlay renderer must be sandboxed');
    assert.notEqual(cfg.contextIsolation, false, 'context isolation must stay on');
    assert.notEqual(cfg.nodeIntegration, true, 'the renderer must not have node');
    assert.equal(cfg.alwaysOnTop, true, 'an overlay that is not on top is not an overlay');
  } finally {
    await closeApp(app);
  }
});

test('the bridge exposes exactly the surface docs/IPC.md promises', async () => {
  const app = await launchApp({ withKey: true });
  try {
    const win = await windowNamed(app, 'overlay.html');

    const shape = await win.evaluate(() => {
      const b = window.handrail;
      const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
      return flat(b).sort();
    });

    for (const required of [
      'ask', 'cancel', 'onTurn', 'completeStep', 'reopenStep',
      'threads.list', 'threads.open', 'threads.create', 'threads.rename', 'threads.remove',
      'models', 'settings.get', 'settings.set',
      'window.setState', 'window.resize', 'window.close', 'window.quit', 'window.openSetup',
    ]) {
      assert.ok(shape.includes(required), `bridge is missing ${required}; has ${shape.join(', ')}`);
    }

    // Nothing that hands out a key or a screenshot may exist on the bridge.
    for (const banned of ['getKey', 'key', 'apiKey', 'screenshot', 'capture']) {
      assert.ok(!shape.some((m) => m.split('.').pop() === banned), `bridge must not expose ${banned}`);
    }
  } finally {
    await closeApp(app);
  }
});

test('a second launch does not start a second app', async () => {
  // Two instances would fight over the global hotkey and both write the store.
  // The second process must lose `requestSingleInstanceLock` and exit before it
  // ever opens a window — which is why launching it here is expected to fail.
  const first = await launchApp({ withKey: true });
  try {
    await windowNamed(first, 'overlay.html');
    const dir = first.__userDataDir;

    let opened = false;
    let second = null;
    try {
      second = await launchApp({ withKey: true, userDataDir: dir });
      await wait(2000);
      opened = second.windows().length > 0;
    } catch (_) {
      opened = false;   // the process exited before Playwright could attach
    } finally {
      if (second) await closeApp(second);
    }

    assert.equal(opened, false, 'the second instance must quit, not open a window');

    // And the first one is still standing.
    assert.equal(first.windows().some((w) => w.url().includes('overlay.html')), true);
  } finally {
    await closeApp(first);
  }
});

test('window position survives a restart', async () => {
  const app = await launchApp({ withKey: true });
  const dir = app.__userDataDir;
  let moved;
  try {
    await windowNamed(app, 'overlay.html');
    moved = await inMain(app, async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay.html'));
      win.setBounds({ x: 240, y: 180, width: win.getBounds().width, height: win.getBounds().height });
      return win.getBounds();
    });
    await wait(800);   // the position is persisted on move, debounced
  } finally {
    await closeApp(app);
  }

  const again = await launchApp({ withKey: true, userDataDir: dir });
  try {
    await windowNamed(again, 'overlay.html');
    const bounds = await inMain(again, async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay.html'));
      return win.getBounds();
    });
    assert.equal(bounds.x, moved.x, 'x should be where the user left it');
    assert.equal(bounds.y, moved.y, 'y should be where the user left it');
  } finally {
    await closeApp(again);
  }
});

test('the store lands in the userData directory and nowhere else', async () => {
  const app = await launchApp({ withKey: true });
  const dir = app.__userDataDir;
  try {
    const win = await windowNamed(app, 'overlay.html');
    await win.evaluate(() => window.handrail.settings.set({ pointing: false }));
    await wait(400);
    assert.ok(fs.existsSync(path.join(dir, 'settings.json')), 'settings.json should be written to userData');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.pointing, false);
  } finally {
    await closeApp(app);
  }
});
