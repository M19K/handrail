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
  // Same price as the previous default, a generation newer. Accuracy at
  // reading a screen is the whole product, so the cheapest adequate model is
  // the right default — not the cheapest model.
  model: 'google/gemini-3.5-flash-lite',
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
    // Set when a stored key was found but could not be decrypted, so
    // onboarding can explain rather than looking like a fresh install.
    this.keyProblem = null;
  }

  // --- settings -----------------------------------------------------------

  getSettings() {
    // keyHint() runs getKey(), which is what sets keyProblem — so read it after.
    const keyHint = this.keyHint();
    return { ...this.settings, keyHint, keyProblem: this.keyProblem };
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
   *
   * Written as JSON with an explicit `enc` field. The first version wrote a
   * bare buffer and inferred the format from whether encryption happened to be
   * available at READ time — so if that answer ever differed between writing
   * and reading, it tried to decrypt plaintext and failed with no way to tell
   * the two cases apart.
   */
  saveKey(key) {
    const value = String(key || '').trim();
    if (!value) return;

    let record;
    if (safeStorage.isEncryptionAvailable()) {
      record = { v: 1, enc: 'os', data: safeStorage.encryptString(value).toString('base64') };
    } else {
      console.warn('[store] OS encryption unavailable — API key stored in plain text');
      record = { v: 1, enc: 'none', data: Buffer.from(value, 'utf8').toString('base64') };
    }

    fs.writeFileSync(this.keyPath, JSON.stringify(record), 'utf8');
    this._key = value;
    this.keyProblem = null;
  }

  getKey() {
    if (this._key) return this._key;

    // .env wins during development so the arrow spike and the app share a key.
    //
    // Gated on !isPackaged, and that gate is load-bearing. dotenv is bundled
    // into the packaged app, so without it a `.env` dropped next to the
    // executable would silently replace the user's key — every screenshot and
    // prompt would then be billed to, and visible in, somebody else's
    // OpenRouter account, with nothing on screen to say so. keyHint would
    // happily show the substituted key's tail.
    if (!app.isPackaged && process.env.OPENROUTER_API_KEY) {
      this._key = process.env.OPENROUTER_API_KEY.trim();
      return this._key;
    }

    if (!fs.existsSync(this.keyPath)) return null;

    const raw = fs.readFileSync(this.keyPath);
    let record = null;
    try {
      record = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      // Not JSON: written by the first version, which stored a bare buffer.
    }

    try {
      if (record && record.v === 1) {
        const buf = Buffer.from(record.data, 'base64');
        this._key = record.enc === 'os' ? safeStorage.decryptString(buf) : buf.toString('utf8');
      } else {
        this._key = safeStorage.decryptString(raw);
      }
      this.keyProblem = null;
      return this._key;
    } catch (err) {
      /**
       * The ciphertext is intact but this machine can no longer decrypt it.
       *
       * On Windows the encryption key lives in `Local State` inside userData;
       * if that is regenerated the stored blob is orphaned permanently. Retrying
       * will never work, so the file is discarded and the reason recorded —
       * otherwise the app silently falls back to "no key set", drops the user
       * into onboarding as though it were a fresh install, and never explains
       * why the key they already entered has vanished.
       */
      console.warn('[store] stored key cannot be decrypted on this machine; discarding it');
      this.keyProblem = 'unreadable';
      try { fs.unlinkSync(this.keyPath); } catch (_) { /* best effort */ }
      return null;
    }
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
