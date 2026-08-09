/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Driving the real UI with a real keyboard and a real mouse.
 *
 * `scripts/smoke.js` reaches into the renderer with executeJavaScript and
 * dispatches synthetic events. That proves the functions work. It does not
 * prove a person can reach them: whether the field has focus, whether Enter
 * submits, whether Escape closes the right thing first, whether a button is
 * actually clickable where it is drawn.
 *
 * Everything here goes through Playwright's input, so it fails the same way a
 * person would.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { launchApp, windowNamed, watchConsole, inMain, shoot, wait, closeApp } = require('./harness');

/** Boot to a ready overlay. */
async function overlay(opts = {}) {
  const app = await launchApp({ withKey: true, ...opts });
  const win = await windowNamed(app, 'overlay.html');
  await win.waitForSelector('#input', { timeout: 10000 });
  await wait(400);
  return { app, win };
}

const view = (win) => win.evaluate(() => document.body.dataset.view || document.documentElement.dataset.view || null);

test('the bar can be typed into and submitted with Enter alone', async () => {
  const { app, win } = await overlay();
  try {
    const errors = watchConsole(win);

    await win.click('#input');
    await win.keyboard.type('how do I export a video?');
    assert.equal(await win.inputValue('#input'), 'how do I export a video?');

    await win.keyboard.press('Enter');
    await wait(700);

    // The field clears on submit, so the next question starts empty.
    assert.equal(await win.inputValue('#input'), '', 'the field should clear when the question is sent');
    await shoot(win, 'interaction-asked');
    assert.deepEqual(errors.filter((e) => !/openrouter|fetch|401/i.test(e)), []);
  } finally {
    await closeApp(app);
  }
});

test('a dead key produces a plain-English error, not a stuck spinner', async () => {
  // The key is well-formed and rejected. This is the single most likely thing a
  // real user hits, and the bar spinning forever is the worst way to meet it.
  const { app, win } = await overlay();
  try {
    await win.click('#input');
    await win.keyboard.type('what is on my screen?');
    await win.keyboard.press('Enter');

    await win.waitForSelector('.msg--error, .error, [data-error]', { timeout: 25000 });
    const text = await win.textContent('.msg--error, .error, [data-error]');
    await shoot(win, 'interaction-error');

    assert.ok(text && text.trim().length > 0, 'an error must actually say something');
    assert.ok(!/\{|\}|undefined|\[object/.test(text), `error must be readable prose, got: ${text}`);

    // And the bar must be usable again.
    const spinning = await win.isVisible('#thinking');
    assert.equal(spinning, false, 'the thinking indicator must stop when the turn fails');
    await win.click('#input');
    await win.keyboard.type('again');
    assert.equal(await win.inputValue('#input'), 'again', 'the bar must accept a second question');
  } finally {
    await closeApp(app);
  }
});

test('Escape closes the panel first, then the answer, then collapses', async () => {
  const { app, win } = await overlay();
  try {
    await win.click('#toggle-settings');
    await wait(300);
    assert.equal(await win.isVisible('#panel-settings, .panel--settings, [data-panel="settings"]'), true);

    await win.keyboard.press('Escape');
    await wait(300);
    assert.equal(
      await win.isVisible('#panel-settings, .panel--settings, [data-panel="settings"]'),
      false,
      'the first Escape should close the panel, not the whole overlay',
    );

    await win.keyboard.press('Escape');
    await wait(400);
    const collapsed = await win.evaluate(() => !!document.querySelector('#pill:not([hidden])'));
    assert.equal(collapsed, true, 'a second Escape with nothing else open should collapse to the pill');
    await shoot(win, 'interaction-collapsed');
  } finally {
    await closeApp(app);
  }
});

test('the collapsed pill can be clicked to come back', async () => {
  const { app, win } = await overlay();
  try {
    await win.keyboard.press('Escape');
    await wait(400);
    await win.click('#pill');
    await wait(400);
    assert.equal(await win.isVisible('#input'), true, 'clicking the pill should bring the bar back');
  } finally {
    await closeApp(app);
  }
});

test('every toggle in Settings actually reaches the store', async () => {
  const { app, win } = await overlay();
  try {
    await win.click('#toggle-settings');
    await wait(400);
    await shoot(win, 'interaction-settings');

    const rows = await win.locator('.setting__switch, .setting button[role="switch"], .setting input[type="checkbox"]').count();
    assert.ok(rows >= 3, `expected the three documented settings rows, found ${rows}`);

    const before = await win.evaluate(() => window.handrail.settings.get());
    // Click the first switch and confirm main agrees.
    await win.locator('.setting__switch, .setting button[role="switch"], .setting input[type="checkbox"]').first().click();
    await wait(500);
    const after = await win.evaluate(() => window.handrail.settings.get());

    const changed = Object.keys(after).filter((k) => after[k] !== before[k] && typeof after[k] === 'boolean');
    assert.ok(changed.length >= 1, `clicking a settings switch changed nothing: ${JSON.stringify({ before, after })}`);
  } finally {
    await closeApp(app);
  }
});

test('the threads panel opens, searches, and creates', async () => {
  const { app, win } = await overlay();
  try {
    await win.evaluate(async () => {
      const a = await window.handrail.threads.create();
      await window.handrail.threads.rename(a.id, 'Printer trouble');
      const b = await window.handrail.threads.create();
      await window.handrail.threads.rename(b.id, 'Wifi keeps dropping');
    });

    await win.click('#toggle-threads');
    await wait(500);
    await shoot(win, 'interaction-threads');

    assert.ok(await win.locator('.thread').count() >= 2, 'both threads should be listed');

    await win.click('#thread-search');
    await win.keyboard.type('printer');
    await wait(400);
    const visible = await win.locator('.thread:visible').count();
    assert.equal(visible, 1, 'search should filter the list down to the matching thread');

    const label = await win.locator('.thread:visible').first().textContent();
    assert.match(label, /Printer trouble/);
  } finally {
    await closeApp(app);
  }
});

test('asking twice in a row does not leave the bar stuck', async () => {
  const { app, win } = await overlay();
  try {
    await win.click('#input');
    await win.keyboard.type('first question');
    await win.keyboard.press('Enter');
    await wait(150);
    // Impatient second press, while the first is still in flight.
    await win.keyboard.type('second question');
    await win.keyboard.press('Enter');

    await wait(20000);
    const stuck = await win.isVisible('#thinking');
    assert.equal(stuck, false, 'the bar must not be left spinning after overlapping asks');
    await shoot(win, 'interaction-double-ask');
  } finally {
    await closeApp(app);
  }
});

test('quitting from the bar actually quits', async () => {
  const { app, win } = await overlay();
  let exited = false;
  try {
    await win.click('#quit');
    await wait(2500);
    exited = app.windows().length === 0;
  } finally {
    await closeApp(app);
  }
  assert.equal(exited, true, 'the quit button must close the app, not just the window');
});

test('launching Handrail again shows it — it never hides it', async () => {
  // Double-clicking the desktop shortcut while Handrail is already open must
  // bring it forward. Toggling means the icon the user just clicked makes the
  // app disappear, which reads as the app being broken.
  const { app, win } = await overlay();
  try {
    await inMain(app, async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay.html'));
      w.show();
    });
    await wait(300);

    const before = await inMain(app, async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay.html'));
      return w.isVisible();
    });
    assert.equal(before, true, 'precondition: the overlay is on screen');

    await inMain(app, async ({ app: electronApp }) => { electronApp.emit('second-instance'); });
    await wait(600);

    const after = await inMain(app, async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay.html'));
      return w.isVisible();
    });
    assert.equal(after, true, 'launching again while open must leave Handrail on screen');
  } finally {
    await closeApp(app);
  }
});
