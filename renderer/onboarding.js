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

$('get-key').addEventListener('click', () => bridge.setup.openExternal('https://openrouter.ai/keys'));

$('finish').addEventListener('click', async () => {
  // Trigger the OS permission prompt here rather than mid-task. Being asked
  // for screen access while you are halfway through a question is jarring, and
  // on macOS it can require restarting the app.
  const status = await bridge.setup.requestScreenAccess();
  if (!status.granted) {
    $('screen-status-text').textContent =
      'Your operating system has not granted screen access yet. Handrail will still ' +
      'answer questions, but it cannot see your screen until you allow it in System Settings.';
  }
  await bridge.setup.complete();
});

$('quit').addEventListener('click', () => bridge.window.quit());

show(0);

/**
 * Explain a discarded key rather than looking like a fresh install.
 *
 * When a stored key cannot be decrypted the store deletes it and records why.
 * Without this the user lands on "Connect an AI provider" with no idea their
 * key ever existed, let alone why it went.
 */
bridge.settings.get()
  .then((settings) => {
    if (settings && settings.keyProblem === 'unreadable') $('key-lost').hidden = false;
  })
  .catch(() => { /* onboarding works without the explanation */ });
