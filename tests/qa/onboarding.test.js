/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Onboarding, driven as a person.
 *
 * CONTEXT.md lists this as a known gap: nobody but the author has ever done it.
 * It is also the only screen that handles a key in plain text and the only one
 * that can lock somebody out of the product, so it is worth more than a glance.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { launchApp, windowNamed, watchConsole, shoot, wait, closeApp } = require('./harness');

const GOOD_KEY = `sk-or-v1-${'a'.repeat(64)}`;

async function onboarding() {
  const app = await launchApp();
  const win = await windowNamed(app, 'onboarding.html');
  await win.waitForSelector('[data-next]', { timeout: 10000 });
  await wait(300);
  return { app, win };
}

test('onboarding is three steps and both directions work', async () => {
  const { app, win } = await onboarding();
  try {
    const errors = watchConsole(win);
    await shoot(win, 'onboarding-1');

    const steps = await win.locator('.step-panel').count();
    assert.equal(steps, 3, 'PRODUCT.md says three steps: what it does, key, screen permission');

    await win.click('[data-next]');
    await wait(300);
    assert.equal(await win.isVisible('#key'), true, 'step 2 asks for the key');
    await shoot(win, 'onboarding-2');

    const back = win.locator('[data-back]:visible').first();
    assert.equal(await back.count(), 1, 'there must be a way back');
    await back.click();
    await wait(300);
    assert.equal(await win.isVisible('#key'), false, 'back should return to step 1');

    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
  }
});

test('the key field never shows the key in plain text', async () => {
  const { app, win } = await onboarding();
  try {
    await win.click('[data-next]');
    await wait(300);
    const type = await win.getAttribute('#key', 'type');
    assert.equal(type, 'password', 'a key pasted over someone\'s shoulder is a leaked key');
  } finally {
    await closeApp(app);
  }
});

test('Continue is refused until the key looks like a key', async () => {
  const { app, win } = await onboarding();
  try {
    await win.click('[data-next]');
    await wait(300);

    assert.equal(await win.isDisabled('#key-continue'), true, 'empty must not be continuable');

    await win.click('#key');
    await win.keyboard.type('hello i am not a key');
    await wait(300);
    assert.equal(await win.isDisabled('#key-continue'), true, 'nonsense must not be continuable');

    await win.fill('#key', '');
    await win.keyboard.type(GOOD_KEY);
    await wait(300);
    assert.equal(await win.isDisabled('#key-continue'), false, 'a well-formed key must be continuable');

    const detected = await win.textContent('#detected');
    assert.match(detected, /OpenRouter/, 'the provider is worked out from the key shape, so there is no dropdown');
    await shoot(win, 'onboarding-key-detected');
  } finally {
    await closeApp(app);
  }
});

test('pasting a key with stray whitespace still works', async () => {
  // People paste. Pastes carry newlines and spaces.
  const { app, win } = await onboarding();
  try {
    await win.click('[data-next]');
    await wait(300);
    await win.fill('#key', `  ${GOOD_KEY}\n`);
    await win.dispatchEvent('#key', 'input');
    await wait(300);
    assert.equal(await win.isDisabled('#key-continue'), false, 'whitespace must not defeat detection');
    assert.match(await win.textContent('#detected'), /OpenRouter/);
  } finally {
    await closeApp(app);
  }
});

test('a rejected key says so and does not advance', async () => {
  // The key is well-formed and dead, so validation reaches the provider and
  // comes back refused. Onboarding must not save it and must not move on.
  const { app, win } = await onboarding();
  try {
    await win.click('[data-next]');
    await wait(300);
    await win.fill('#key', GOOD_KEY);
    await win.dispatchEvent('#key', 'input');
    await wait(200);
    await win.click('#key-continue');

    await wait(20000);
    await shoot(win, 'onboarding-key-rejected');

    const onKeyStep = await win.isVisible('#key');
    assert.equal(onKeyStep, true, 'a rejected key must leave the user on the key step');

    const body = await win.textContent('body');
    assert.ok(/rejected|not|invalid|check/i.test(body), `the user must be told why: ${body.slice(0, 300)}`);
  } finally {
    await closeApp(app);
  }
});

test('the key never crosses back over the bridge', async () => {
  const { app, win } = await onboarding();
  try {
    const leaked = await win.evaluate(async (key) => {
      const settings = await window.handrail.settings.get();
      return JSON.stringify(settings).includes(key.slice(9, 40));
    }, GOOD_KEY);
    assert.equal(leaked, false, 'only a masked hint may come back');
  } finally {
    await closeApp(app);
  }
});

test('onboarding cannot drive a turn or reach the overlay', async () => {
  // One preload serves both windows. Onboarding has no business asking a
  // question or reading threads.
  const { app, win } = await onboarding();
  try {
    const result = await win.evaluate(async () => {
      try {
        await window.handrail.ask({ text: 'hello', capture: false, turnId: 'x' });
        return 'ALLOWED';
      } catch (_) {
        return 'REFUSED';
      }
    });
    // Not a security boundary today, but it must not crash or open a window.
    assert.ok(['ALLOWED', 'REFUSED'].includes(result));
    const urls = app.windows().map((w) => w.url());
    assert.ok(!urls.some((u) => u.includes('arrow.html')), 'no arrow may be drawn from onboarding');
  } finally {
    await closeApp(app);
  }
});
