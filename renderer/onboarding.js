/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — onboarding.
 *
 * Three steps, no account, no email. The middle one is the only one that
 * actually asks the user for anything.
 *
 * The single key field with no provider dropdown is a product decision
 * (PRODUCT.md): the shape of the key already says which provider it is, so
 * asking the user to tell us as well is asking them to know something they
 * came here to avoid needing to know.
 */

'use strict';

const bridge = window.handrail;

const $ = (id) => document.getElementById(id);

const panels = [...document.querySelectorAll('.step-panel')];
const dots = [...document.querySelectorAll('.progress i')];
const keyInput = $('key');
const keyField = $('key-field');
const detected = $('detected');
const keyContinue = $('key-continue');

let step = 0;
let validated = null;   // { valid, provider } for the key currently in the box

function show(index) {
  step = Math.max(0, Math.min(panels.length - 1, index));
  panels.forEach((p, i) => p.classList.toggle('active', i === step));
  dots.forEach((d, i) => d.classList.toggle('on', i <= step));
  if (step === 1) keyInput.focus();
}

/**
 * Provider from key shape. Mirrors `providerOf` in src/main/store.js.
 *
 * Duplicated on purpose: this one runs on every keystroke to give instant
 * feedback, and round-tripping to main for that would make the field feel
 * laggy. Main remains the authority — it re-derives the provider when the key
 * is actually saved, so a mismatch here can only ever be cosmetic.
 */
function providerOf(key) {
  const k = key.trim();
  if (/^sk-or-v1-/.test(k)) return 'OpenRouter';
  if (/^sk-ant-/.test(k)) return 'Anthropic';
  if (/^sk-[A-Za-z0-9_-]{20,}/.test(k)) return 'OpenAI';
  if (/^AIza[A-Za-z0-9_-]{20,}/.test(k)) return 'Google';
  return null;
}

const ICON_TICK = 'M5 13l4 4L19 7';
const ICON_CROSS = 'M6 6l12 12M18 6L6 18';

function setDetected(mode, text) {
  detected.replaceChildren();
  detected.className = 'detected';
  if (!mode) return;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', mode === 'ok' ? ICON_TICK : ICON_CROSS);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  detected.append(svg, document.createTextNode(text));
  detected.classList.add('show', mode);
}

keyInput.addEventListener('input', () => {
  const value = keyInput.value.trim();
  validated = null;

  if (!value) {
    keyField.removeAttribute('data-state');
    setDetected(null);
    keyContinue.disabled = true;
    return;
  }

  const provider = providerOf(value);
  if (provider) {
    keyField.setAttribute('data-state', 'valid');
    setDetected('ok', provider);
    keyContinue.disabled = false;
  } else {
    // Not an error yet — they may still be typing. Say nothing rather than
    // flashing red at someone who is halfway through a paste.
    keyField.removeAttribute('data-state');
    setDetected(null);
    keyContinue.disabled = true;
  }
});

// Enter submits, because the field is the only thing on the screen.
keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !keyContinue.disabled) advanceFromKey();
});

/**
 * Verify the key against the provider before letting the user past.
 *
 * Worth the round trip: a typo caught here costs three seconds, and the same
 * typo discovered later shows up as a failed answer in the middle of a task,
 * where the user has no idea the key was the problem.
 */
async function advanceFromKey() {
  const value = keyInput.value.trim();
  if (!value) return;

  keyContinue.disabled = true;
  keyContinue.textContent = 'Checking…';

  try {
    const result = await bridge.setup.validateKey(value);
    validated = result;

    if (!result.valid) {
      keyField.setAttribute('data-state', 'invalid');
      setDetected('bad', 'Rejected');
      keyContinue.textContent = 'Continue';
      keyContinue.disabled = false;
      return;
    }

    await bridge.setup.saveKey(value);
    keyField.setAttribute('data-state', 'valid');
    setDetected('ok', result.provider || 'Connected');
    keyContinue.textContent = 'Continue';
    keyContinue.disabled = false;
    show(2);
  } catch (err) {
    keyField.setAttribute('data-state', 'invalid');
    setDetected('bad', 'Check failed');
    keyContinue.textContent = 'Continue';
    keyContinue.disabled = false;
  }
}

for (const button of document.querySelectorAll('[data-next]')) {
  button.addEventListener('click', () => {
    if (step === 1) advanceFromKey();
    else show(step + 1);
  });
}
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => show(step - 1));
}

$('get-key').addEventListener('click', () => bridge.setup.openExternal('get-key'));

/**
 * Whether the user has already been shown that screen access is missing.
 *
 * The second press of the button has to let them through. Without this the
 * button re-checks a permission that cannot have changed — macOS binds it at
 * launch — reprints the same warning and never finishes, which is a dead end
 * rather than a warning.
 */
let screenAccessWarned = false;

$('finish').addEventListener('click', async () => {
  // Trigger the OS permission prompt here rather than mid-task. Being asked
  // for screen access while you are halfway through a question is jarring, and
  // on macOS it can require restarting the app.
  if (screenAccessWarned) {
    await bridge.setup.complete();
    return;
  }

  const status = await bridge.setup.requestScreenAccess();

  if (status.granted) {
    await bridge.setup.complete();
    return;
  }

  screenAccessWarned = true;

  /**
   * Stop here rather than finishing setup into a broken state.
   *
   * This used to write a sentence into the panel and then complete anyway, so
   * the user landed on the overlay believing they were set up. Their first
   * question came back "Failed to get sources" with a Try again button that
   * could not ever succeed.
   *
   * `needsRestart` is the case worth separating: macOS binds screen-recording
   * access when the process launches, so a permission granted just now — in
   * the prompt, or by hand in System Settings — does nothing at all until
   * Handrail restarts. Nothing in the product said so, and it is not something
   * anyone would guess.
   */
  $('screen-status-text').textContent = status.needsRestart
    ? 'Screen access is allowed, but Handrail has to restart before it can use it — ' +
      'macOS only checks that permission when the app starts.'
    : 'Handrail does not have screen access yet. Allow it under Privacy & Security → ' +
      'Screen & System Audio Recording, then restart Handrail.';

  $('screen-actions').hidden = false;
  $('restart-handrail').hidden = !status.needsRestart;
  // Setup is finished apart from this, so let them through if they insist —
  // the answer path still works without a screenshot, it just cannot see.
  $('finish').textContent = 'Continue without screen access';
});

$('open-screen-settings').addEventListener('click', () => {
  bridge.setup.openScreenSettings();
  // Granting it over there needs a restart over here, and they are about to.
  $('restart-handrail').hidden = false;
});

$('restart-handrail').addEventListener('click', async () => {
  await bridge.setup.complete();
  bridge.setup.relaunch();
});

$('quit').addEventListener('click', () => bridge.window.quit());

show(0);

/**
 * Explain a discarded key rather than looking like a fresh install.
 *
 * When a stored key cannot be used, the store records why. Without this the
 * user lands on "Connect an AI provider" with no idea their key ever existed,
 * let alone why it went.
 *
 * Two reasons, deliberately worded differently, because they are not the same
 * event to the person reading them:
 *
 *   foreign     expected, and their key is fine. A different build of Handrail
 *               saved it — an update, or a reinstall. Nothing is wrong and
 *               nothing was lost; it just has to be pasted again. See
 *               `store.js` for why the app refuses to open it.
 *   unreadable  something actually failed. The OS could not decrypt it and it
 *               is not coming back.
 *
 * Neither mentions an operating system by name. The previous copy named Windows
 * and was shown to everyone, on every platform, on every first run.
 */
const KEY_PROBLEM_COPY = {
  foreign:
    'Handrail was updated or reinstalled, so it needs your key once more. ' +
    'Nothing is wrong with the key itself — paste it again and it will be saved fresh.',
  unreadable:
    'Your saved key could not be read on this computer, and that cannot be undone. ' +
    'Paste it again and it will be saved fresh.',
};

bridge.settings.get()
  .then((settings) => {
    const copy = settings && KEY_PROBLEM_COPY[settings.keyProblem];
    if (!copy) return;
    $('key-lost-text').textContent = copy;
    $('key-lost').hidden = false;
  })
  .catch(() => { /* onboarding works without the explanation */ });
