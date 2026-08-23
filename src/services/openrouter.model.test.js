/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Model resolution never substitutes silently.
 *
 * `mapModel` used to answer `google/gemini-2.5-flash` for four different
 * situations — a bare legacy name, an unknown name, an empty string, and an env
 * override — with no error and nothing in the log, while the user's model
 * picker still showed what they had chosen. `gemini-3.5-flash` in particular
 * mapped to 2.5: a different, older model.
 *
 * Same shape as the locate token cap: a value quietly replaced by a plausible
 * one, invisible until somebody measures the output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapModel } = require('./openrouter.adapter');

/** Run `fn` with console.warn captured. */
function warnings(fn) {
  const seen = [];
  const real = console.warn;
  console.warn = (...args) => seen.push(args.join(' '));
  try { return { result: fn(), seen }; } finally { console.warn = real; }
}

test('a provider-qualified id passes through untouched and silently', () => {
  const { result, seen } = warnings(() => mapModel('google/gemini-3.5-flash'));
  assert.equal(result, 'google/gemini-3.5-flash');
  assert.equal(seen.length, 0, 'the common case must not be noisy');
});

test('gemini-3.5-flash is NOT downgraded to 2.5 any more', () => {
  const { result } = warnings(() => mapModel('gemini-3.5-flash'));
  assert.notEqual(result, 'google/gemini-2.5-flash',
    'this silently gave users an older model than the one they named');
  assert.equal(result, 'google/gemini-3.5-flash');
});

test('an unrecognised name falls back LOUDLY, and says what is wrong with it', () => {
  const { result, seen } = warnings(() => mapModel('gpt-4o'));
  assert.equal(result, 'google/gemini-3.5-flash');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /unrecognised model/i);
  assert.match(seen[0], /provider prefix/i, 'tell them how to fix it, not just that it broke');
});

test('an empty model says so rather than pretending one was chosen', () => {
  const { result, seen } = warnings(() => mapModel(''));
  assert.equal(result, 'google/gemini-3.5-flash');
  assert.match(seen[0], /no model set/i);
});

test('a genuinely legacy name still maps, and announces the mapping', () => {
  const { result, seen } = warnings(() => mapModel('gemini-1.5-pro'));
  assert.equal(result, 'google/gemini-pro-1.5');
  assert.match(seen[0], /legacy model name/i);
});

test('an env override announces that it beat the user’s choice', () => {
  process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-5';
  try {
    const { result, seen } = warnings(() => mapModel('google/gemini-3.5-flash'));
    assert.equal(result, 'anthropic/claude-sonnet-5');
    assert.match(seen[0], /overriding the selected model/i,
      'the picker still shows the user’s choice, so this has to be visible somewhere');
  } finally {
    delete process.env.OPENROUTER_MODEL;
  }
});

test('an env override matching the selection is not worth a warning', () => {
  process.env.OPENROUTER_MODEL = 'google/gemini-3.5-flash';
  try {
    const { seen } = warnings(() => mapModel('google/gemini-3.5-flash'));
    assert.equal(seen.length, 0);
  } finally {
    delete process.env.OPENROUTER_MODEL;
  }
});
