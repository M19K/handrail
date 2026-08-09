/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * The overlay as a window, and as something a person has to operate.
 *
 * Handrail's audience is explicitly people who are not technical and who may be
 * struggling already. A control that cannot be reached by keyboard, or a window
 * that grows off the bottom of the screen, fails that audience first.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { launchApp, windowNamed, inMain, shoot, wait, closeApp } = require('./harness');

async function overlay() {
  const app = await launchApp({ withKey: true });
  const win = await windowNamed(app, 'overlay.html');
  await win.waitForSelector('#input', { timeout: 10000 });
  await wait(400);
  return { app, win };
}

test('the question field has focus the moment Handrail opens', async () => {
  // The product is summoned mid-task by someone who is stuck. Making them click
  // into the field first is a step for nothing.
  const { app, win } = await overlay();
  try {
    const focused = await win.evaluate(() => document.activeElement && document.activeElement.id);
    assert.equal(focused, 'input', `expected the question field to be focused, got "${focused}"`);
  } finally {
    await closeApp(app);
  }
});

test('every control in the bar has an accessible name', async () => {
  const { app, win } = await overlay();
  try {
    const unnamed = await win.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#bar button, #bar [role="button"]')) {
        if (el.offsetParent === null) continue;   // not visible, not reachable
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
        if (!name) out.push(el.id || el.className || el.outerHTML.slice(0, 60));
      }
      return out;
    });
    assert.deepEqual(unnamed, [], 'an icon-only button with no label is unusable with a screen reader');
  } finally {
    await closeApp(app);
  }
});

test('every control in the bar can be reached with Tab', async () => {
  const { app, win } = await overlay();
  try {
    const unreachable = await win.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#bar button, #bar [role="button"]')) {
        if (el.offsetParent === null) continue;
        if (el.tabIndex < 0) out.push(el.id || el.className);
      }
      return out;
    });
    assert.deepEqual(unreachable, [], 'a control with tabIndex -1 cannot be reached without a mouse');
  } finally {
    await closeApp(app);
  }
});

test('the window grows with the answer but never off the screen', async () => {
  const { app, win } = await overlay();
  try {
    const before = await inMain(app, async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay.html'));
      return w.getBounds();
    });

    // A long answer, pushed through the real event stream.
    await win.evaluate(() => {
      const turnId = 'qa-long';
      // The renderer drops events for turns it does not own, so start one.
      document.getElementById('input').value = 'tell me everything';
      document.getElementById('bar').dispatchEvent(new Event('submit', { cancelable: true }));
      return turnId;
    });
    await wait(400);
    await win.evaluate(() => {
      const long = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: do the thing that comes next.`).join('\n\n');
      const el = document.querySelector('.msg--assistant .prose') || document.querySelector('.msg--assistant');
      if (el) el.textContent = long;
      window.dispatchEvent(new Event('resize'));
    });
    await wait(1200);

    const after = await inMain(app, async ({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay.html'));
      const b = w.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      return { b, wa };
    });
    await shoot(win, 'overlay-long-answer');

    assert.ok(after.b.height >= before.height, 'the window should not shrink when the answer grows');
    assert.ok(
      after.b.height <= after.wa.height,
      `the overlay is ${after.b.height}px tall on a ${after.wa.height}px work area — it would run off screen`,
    );
    assert.ok(
      after.b.y + after.b.height <= after.wa.y + after.wa.height + 1,
      `the overlay bottom (${after.b.y + after.b.height}) is past the bottom of the work area (${after.wa.y + after.wa.height})`,
    );
  } finally {
    await closeApp(app);
  }
});

test('stealth is applied to the real window, not just stored', async () => {
  const { app, win } = await overlay();
  try {
    await win.evaluate(() => window.handrail.settings.set({ stealth: false }));
    await wait(400);
    const off = await inMain(app, async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay.html'));
      return w.isContentProtected ? w.isContentProtected() : null;
    });

    await win.evaluate(() => window.handrail.settings.set({ stealth: true }));
    await wait(400);
    const on = await inMain(app, async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay.html'));
      return w.isContentProtected ? w.isContentProtected() : null;
    });

    if (off === null || on === null) return;   // Electron too old to ask
    assert.equal(off, false, 'turning stealth off must actually uncover the window');
    assert.equal(on, true, 'turning stealth on must actually protect it — a toggle that needs a restart reads as broken');
  } finally {
    await closeApp(app);
  }
});

test('the renderer cannot be navigated away from the overlay', async () => {
  // A prompt-injected link in a model answer must not turn the overlay into a
  // browser pointed at somebody else's site.
  const { app, win } = await overlay();
  try {
    const before = win.url();
    await win.evaluate(() => { window.location.href = 'https://example.com/'; });
    await wait(1200);
    assert.equal(win.url(), before, 'the overlay must stay on its own file');
  } finally {
    await closeApp(app);
  }
});
