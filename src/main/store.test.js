/**
 * Provider detection from key shape.
 *
 * This is the whole reason onboarding has one field and no dropdown, so it is
 * worth testing properly. Runs on Node's built-in runner with no Electron —
 * `providerOf` is deliberately a free function for exactly that reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// `store.js` imports electron for the Store class. Stub it so the pure helper
// can be tested without booting an app.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function stubElectron(request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => '.' }, safeStorage: {} };
  return originalLoad.call(this, request, ...rest);
};
const { providerOf } = require('./store');
Module._load = originalLoad;

test('recognises an OpenRouter key', () => {
  assert.equal(providerOf('sk-or-v1-' + 'a'.repeat(64)), 'OpenRouter');
});

test('recognises an Anthropic key', () => {
  assert.equal(providerOf('sk-ant-api03-' + 'x'.repeat(40)), 'Anthropic');
});

test('recognises a Google key', () => {
  assert.equal(providerOf('AIzaSyD-' + 'b'.repeat(30)), 'Google');
});

test('falls through to OpenAI for a bare sk- key', () => {
  // Order is load-bearing: sk-ant- and sk-or- both start with sk-, so the
  // generic OpenAI check has to run last or it swallows both.
  assert.equal(providerOf('sk-proj-' + 'c'.repeat(40)), 'OpenAI');
});

test('OpenRouter and Anthropic are not misread as OpenAI', () => {
  assert.notEqual(providerOf('sk-or-v1-abc'), 'OpenAI');
  assert.notEqual(providerOf('sk-ant-abc'), 'OpenAI');
});

test('rejects things that are not keys', () => {
  for (const value of ['', '   ', 'hello', 'my key is sk-or-v1-abc', undefined, null]) {
    assert.equal(providerOf(value), 'Unknown', `should reject ${JSON.stringify(value)}`);
  }
});

test('tolerates surrounding whitespace', () => {
  // Users paste. Pastes carry whitespace.
  assert.equal(providerOf('  sk-or-v1-' + 'a'.repeat(64) + '\n'), 'OpenRouter');
});
