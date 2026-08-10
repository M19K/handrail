/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Provider detection from key shape.
 *
 * This is the whole reason onboarding has one field and no dropdown, so it is
 * worth testing properly. Runs on Node's built-in runner with no Electron —
 * `providerOf` is deliberately a free function for exactly that reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A throwaway userData directory per construction, so a corrupt-store test
// cannot touch the real installed app. Removed on exit: `doctor-mac.js` counts
// stray `handrail-*` temp directories as a signal that a second instance may be
// running against a store of its own, and suite debris drowns that out.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'handrail-store-test-'));
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));

// `store.js` imports electron for the Store class. Stub it so both the pure
// helper and the disk-recovery paths can run without booting an app.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function stubElectron(request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA, isPackaged: true, getVersion: () => '0.0.0-test' },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return originalLoad.call(this, request, ...rest);
};
const { Store, providerOf } = require('./store');
Module._load = originalLoad;

/** A fresh Store over `threads.json` containing exactly this text. */
function storeWithThreadsFile(contents) {
  fs.writeFileSync(path.join(DATA, 'threads.json'), contents, 'utf8');
  return new Store();
}

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

// --- a corrupt store must not stop the app launching ------------------------
//
// `_readJson` recovers from unparseable JSON but returns whatever DID parse.
// A `threads.json` containing `null` therefore set this.threads = null and the
// first listThreads() threw on boot — the exact failure the recovery exists to
// prevent, and the comment above it promised the opposite.

test('threads.json containing null does not break boot', () => {
  const store = storeWithThreadsFile('null');
  assert.deepEqual(store.listThreads(), []);
});

test('threads.json containing an object does not break boot', () => {
  const store = storeWithThreadsFile('{"not":"an array"}');
  assert.deepEqual(store.listThreads(), []);
});

test('unparseable threads.json does not break boot', () => {
  const store = storeWithThreadsFile('{ this is not json');
  assert.deepEqual(store.listThreads(), []);
});

test('junk entries inside a valid array are dropped, real ones kept', () => {
  const store = storeWithThreadsFile(JSON.stringify([
    null,
    'a string',
    { id: 't1', title: 'Real', updatedAt: 5, turns: [] },
  ]));
  const listed = store.listThreads();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 't1');
});

test('a thread with no updatedAt does not scramble the sort', () => {
  const store = storeWithThreadsFile(JSON.stringify([
    { id: 'old', title: 'Old', updatedAt: 10, turns: [] },
    { id: 'undated', title: 'Undated', turns: [] },
    { id: 'new', title: 'New', updatedAt: 20, turns: [] },
  ]));
  assert.deepEqual(store.listThreads().map((t) => t.id), ['new', 'old', 'undated']);
});

test('a good store still reads back', () => {
  const store = storeWithThreadsFile('[]');
  const t = store.createThread();
  store.appendTurn(t.id, { prompt: 'How do I add a cross dissolve?', kind: 'answer', markdown: 'x' });
  assert.equal(store.getThread(t.id).title, 'How do I add a cross dissolve?');
  assert.equal(store.listThreads().length, 1);
});

test('thread history is capped', () => {
  const store = storeWithThreadsFile('[]');
  const t = store.createThread();
  for (let i = 0; i < 50; i += 1) store.appendTurn(t.id, { prompt: `p${i}`, kind: 'answer', markdown: 'x' });
  const turns = store.getThread(t.id).turns;
  assert.equal(turns.length, 40);
  assert.equal(turns[turns.length - 1].prompt, 'p49', 'the newest turns are the ones kept');
});

test('a short key is not leaked by its own hint', () => {
  // slice(0,9) and slice(-4) overlap below 13 characters, so the hint used to
  // print the value almost whole: `Unknown · short••••hort`.
  const store = storeWithThreadsFile('[]');
  store._key = 'short';
  assert.equal(store.keyHint().includes('short'), false, store.keyHint());
  store._key = 'sk-or-v1-abcdefghijklmnop';
  assert.match(store.keyHint(), /^OpenRouter · sk-or-v1-••••mnop$/);
});
