/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * The stored key is only opened by the build that saved it.
 *
 * Regression cover for the worst bug Handrail has shipped. The macOS 0.1.3
 * build would start, create no window, draw no tray icon and register no
 * hotkey — a live process with no way in and no way out but Force Quit.
 *
 * The cause was `safeStorage.decryptString()` on a Keychain item belonging to a
 * different code signature. macOS answers that with an authorisation prompt;
 * Handrail sets LSUIElement so at boot it has no window for the prompt to
 * attach to; `decryptString` is synchronous, so main blocked inside it before
 * any of the recovery UI existed. Handrail is distributed unsigned, so its
 * ad-hoc signature changes every build — meaning every update would do this.
 *
 * The fix refuses to ask the OS about a key we cannot prove we own. These tests
 * hold that refusal in place, and hold it to macOS only: on Windows the secret
 * is DPAPI-scoped to the USER and survives updates, so applying the same rule
 * there would make people re-enter their key for no reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');

const VERSION = '9.9.9';
const PLAINTEXT = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';

/**
 * Load a fresh copy of store.js against a stubbed Electron and platform.
 *
 * Re-required per case because the macOS-only rule is resolved once at module
 * load — which is the right shape for production and means a test that wants
 * the other platform has to load the module again.
 */
function loadStore({ platform, packaged = true, dir }) {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  const originalLoad = Module._load;
  Module._load = function stubElectron(request, ...rest) {
    if (request === 'electron') {
      return {
        app: { getPath: () => dir, isPackaged: packaged, getVersion: () => VERSION },
        safeStorage: {
          isEncryptionAvailable: () => true,
          // A stand-in for the OS keychain: reversible, and — importantly —
          // it always succeeds. If a test sees a key come back, it is because
          // the guard let the call through, never because decryption "worked".
          encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
          decryptString: (b) => {
            const s = b.toString('utf8');
            if (!s.startsWith('enc:')) throw new Error('cannot decrypt');
            return s.slice(4);
          },
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };

  delete require.cache[require.resolve('./store')];
  const mod = require('./store');

  Module._load = originalLoad;
  delete require.cache[require.resolve('./store')];
  Object.defineProperty(process, 'platform', realPlatform);
  return mod;
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'handrail-keyowner-'));
}

function writeKeyRecord(dir, record) {
  fs.writeFileSync(path.join(dir, 'key.dat'), JSON.stringify(record), 'utf8');
}

test('macOS: a key saved by this same build is opened normally', () => {
  const dir = freshDir();
  const { Store } = loadStore({ platform: 'darwin', dir });

  const writer = new Store();
  writer.saveKey(PLAINTEXT);

  // A second Store over the same directory is the next launch of the same build.
  const reader = new Store();
  assert.equal(reader.getKey(), PLAINTEXT);
  assert.equal(reader.keyProblem, null);
});

test('macOS: a key saved by a different build is NOT handed to the keychain', () => {
  const dir = freshDir();
  const { Store } = loadStore({ platform: 'darwin', dir });

  writeKeyRecord(dir, {
    v: 2,
    enc: 'os',
    data: Buffer.from(`enc:${PLAINTEXT}`, 'utf8').toString('base64'),
    owner: 'app-0.0.1-some-older-release',
  });

  const store = new Store();
  // Null, even though the stub decryptString would have succeeded — proving the
  // guard ran instead of the OS call. In production that call is the one that
  // blocks main forever.
  assert.equal(store.getKey(), null);
  assert.equal(store.keyProblem, 'foreign');
});

test('macOS: a key with no recorded owner is treated as foreign, not decrypted', () => {
  const dir = freshDir();
  const { Store } = loadStore({ platform: 'darwin', dir });

  // What every install written before this fix has on disk. Ownership cannot be
  // proven, so it must not be opened — an unprovable key is the exact case that
  // hung 0.1.3.
  writeKeyRecord(dir, {
    v: 1,
    enc: 'os',
    data: Buffer.from(`enc:${PLAINTEXT}`, 'utf8').toString('base64'),
  });

  const store = new Store();
  assert.equal(store.getKey(), null);
  assert.equal(store.keyProblem, 'foreign');
});

test('Windows: the same foreign key IS opened — DPAPI is scoped to the user, not the build', () => {
  const dir = freshDir();
  const { Store } = loadStore({ platform: 'win32', dir });

  writeKeyRecord(dir, {
    v: 2,
    enc: 'os',
    data: Buffer.from(`enc:${PLAINTEXT}`, 'utf8').toString('base64'),
    owner: 'app-0.0.1-some-older-release',
  });

  const store = new Store();
  assert.equal(store.getKey(), PLAINTEXT);
  assert.equal(store.keyProblem, null);
});

test('a plaintext-fallback key is unaffected by the ownership rule', () => {
  const dir = freshDir();
  const { Store } = loadStore({ platform: 'darwin', dir });

  // `enc: 'none'` never touches the keychain, so there is nothing to prove and
  // nothing that can block.
  writeKeyRecord(dir, {
    v: 2,
    enc: 'none',
    data: Buffer.from(PLAINTEXT, 'utf8').toString('base64'),
  });

  const store = new Store();
  assert.equal(store.getKey(), PLAINTEXT);
});

test('saving records the current build as the owner', () => {
  const dir = freshDir();
  const { Store } = loadStore({ platform: 'darwin', dir });

  new Store().saveKey(PLAINTEXT);

  const record = JSON.parse(fs.readFileSync(path.join(dir, 'key.dat'), 'utf8'));
  assert.equal(record.enc, 'os');
  assert.equal(record.owner, `app-${VERSION}`);
});

test('a dev run and a packaged run are different owners', () => {
  const dir = freshDir();

  const dev = new (loadStore({ platform: 'darwin', packaged: false, dir }).Store)();
  dev.saveKey(PLAINTEXT);

  // The packaged app reading what `npm start` wrote — the exact combination
  // that was reproduced against the shipped 0.1.3 build.
  const packaged = new (loadStore({ platform: 'darwin', packaged: true, dir }).Store)();
  assert.equal(packaged.getKey(), null);
  assert.equal(packaged.keyProblem, 'foreign');
});
