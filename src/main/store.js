/**
 * Handrail — persistence.
 *
 * Settings, threads and the API key. Everything lives under Electron's
 * userData directory; nothing leaves the machine.
 *
 * Deliberately plain JSON on disk rather than a database. The whole store is a
 * settings object and a list of conversations — small enough to read in one
 * gulp, and a format the user can open and inspect, which matters for a product
 * whose main privacy claim is "it all stays here".
 */

const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_SETTINGS = {
  capture: true,     // every question includes a screenshot
  pointing: true,    // draw the arrow
  stealth: true,     // hide from screen capture
  watching: true,    // auto-advance steps by looking at the screen
  model: 'google/gemini-2.5-flash',
};

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.settingsPath = path.join(this.dir, 'settings.json');
    this.threadsPath = path.join(this.dir, 'threads.json');
    this.keyPath = path.join(this.dir, 'key.dat');

    this.settings = { ...DEFAULT_SETTINGS, ...this._readJson(this.settingsPath, {}) };
    this.threads = this._readJson(this.threadsPath, []);
    this._key = null;
  }

  // --- settings -----------------------------------------------------------

  getSettings() {
    return { ...this.settings, keyHint: this.keyHint() };
  }

  setSettings(patch) {
    // keyHint is derived, never stored — accepting it back would let a stale
    // renderer copy overwrite the real hint.
    const { keyHint, ...rest } = patch || {};
    Object.assign(this.settings, rest);
    this._writeJson(this.settingsPath, this.settings);
    return this.getSettings();
  }

  // --- API key ------------------------------------------------------------

  /**
   * Encrypted at rest via the OS keychain (DPAPI on Windows, Keychain on
   * macOS) when available. `safeStorage` is unavailable on some Linux setups
   * without a keyring, so there is a plaintext fallback — but it announces
   * itself rather than silently pretending to be encrypted.
   */
  saveKey(key) {
    const value = String(key || '').trim();
    if (!value) return;

    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(this.keyPath, safeStorage.encryptString(value));
    } else {
      console.warn('[store] OS encryption unavailable — API key stored in plain text');
      fs.writeFileSync(this.keyPath, value, 'utf8');
    }
    this._key = value;
  }

  getKey() {
    if (this._key) return this._key;

    // .env wins during development so the arrow spike and the app share a key.
    if (process.env.OPENROUTER_API_KEY) {
      this._key = process.env.OPENROUTER_API_KEY.trim();
      return this._key;
    }

    if (!fs.existsSync(this.keyPath)) return null;
    try {
      const raw = fs.readFileSync(this.keyPath);
      this._key = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8');
    } catch (err) {
      // A key that cannot be decrypted is a key the user must re-enter —
      // usually because the OS profile changed. Fail to "not set", not to a crash.
      console.warn('[store] could not read stored key:', err.message);
      return null;
    }
    return this._key;
  }

  /** Masked tail. The only form of the key the renderer is ever given. */
  keyHint() {
    const key = this.getKey();
    if (!key) return '';
    return `${providerOf(key)} · ${key.slice(0, 9)}••••${key.slice(-4)}`;
  }

  // --- threads ------------------------------------------------------------

  listThreads() {
    return this.threads
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(id) {
    return this.threads.find((t) => t.id === id) || null;
  }

  createThread() {
    const thread = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title: 'New thread',
      updatedAt: Date.now(),
      turns: [],
    };
    this.threads.push(thread);
    this._persistThreads();
    return thread;
  }

  renameThread(id, title) {
    const thread = this.getThread(id);
    if (!thread) return;
    thread.title = String(title || '').slice(0, 80) || 'Untitled';
    thread.updatedAt = Date.now();
    this._persistThreads();
  }

  removeThread(id) {
    const i = this.threads.findIndex((t) => t.id === id);
    if (i > -1) {
      this.threads.splice(i, 1);
      this._persistThreads();
    }
  }

  /**
   * Append a turn, and title the thread from the first prompt.
   *
   * Auto-titling on the first prompt rather than asking the model for a title:
   * it is free, instant, and a truncated prompt is a better label than a
   * generated one for finding a conversation you had yourself.
   */
  appendTurn(threadId, turn) {
    const thread = this.getThread(threadId);
    if (!thread) return;

    thread.turns.push(turn);
    thread.updatedAt = Date.now();

    if (thread.title === 'New thread' && turn.prompt) {
      thread.title = turn.prompt.slice(0, 60);
    }

    // Cap history. Long threads are what maxes out a context window, and the
    // product's own answer to that is "start a new thread".
    if (thread.turns.length > 40) thread.turns = thread.turns.slice(-40);

    this._persistThreads();
  }

  // --- io -----------------------------------------------------------------

  _readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // A corrupt store must not stop the app launching. The user loses
      // history, not the product.
      console.warn(`[store] ${path.basename(file)} unreadable, starting fresh:`, err.message);
      return fallback;
    }
  }

  _writeJson(file, value) {
    try {
      fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    } catch (err) {
      console.error(`[store] could not write ${path.basename(file)}:`, err.message);
    }
  }

  _persistThreads() {
    this._writeJson(this.threadsPath, this.threads);
  }
}

/**
 * Which provider a key belongs to, from its shape.
 *
 * This is what lets onboarding have one field and no dropdown — see
 * PRODUCT.md. Order matters: `sk-ant-` and `sk-or-` both start with `sk-`,
 * so the generic OpenAI check has to come last.
 */
function providerOf(key) {
  const k = String(key || '').trim();
  if (/^sk-or-v1-/.test(k)) return 'OpenRouter';
  if (/^sk-ant-/.test(k)) return 'Anthropic';
  if (/^sk-/.test(k)) return 'OpenAI';
  if (/^AIza/.test(k)) return 'Google';
  return 'Unknown';
}

module.exports = { Store, providerOf, DEFAULT_SETTINGS };
