/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
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
  /**
   * Accuracy at reading a screen is the whole product, so the default is the
   * cheapest ADEQUATE model, not the cheapest model.
   *
   * Was `gemini-3.5-flash-lite` ($0.30/$2.50 per million). The lite tier kept
   * inventing menu paths for UI that was not in the screenshot — Obsidian's
   * vault location being the standing example — and `prompts.js` already tells
   * it in as many words never to guess at a path it cannot see. An instruction
   * the model ignores is a capability problem, not a prompt problem.
   *
   * `gemini-3.5-flash` is $1.50/$9.00, so roughly 4x. In absolute terms that is
   * still fractions of a penny per question, and being wrong is far more
   * expensive than being slow: this product is aimed at people who cannot tell
   * a wrong instruction from a right one.
   *
   * `scripts/compare-models.js` runs your own screen through several models
   * side by side if you want to check this rather than take it on faith.
   */
  model: 'google/gemini-3.5-flash',
};

/**
 * Is keychain ownership something we have to prove before asking the OS?
 *
 * Only on macOS, and only there because of how the secret is scoped:
 *
 *   macOS   Keychain, ACL bound to the app's CODE SIGNATURE. Handrail ships
 *           unsigned, so its ad-hoc signature changes every build — a key
 *           written by one build genuinely does not belong to the next one.
 *   Windows DPAPI, scoped to the USER. Survives updates, reinstalls and moves.
 *   Linux   libsecret, scoped to the login keyring. Same.
 *
 * Doing this everywhere would make Windows users re-enter their key after every
 * update to solve a problem Windows does not have. See getKey() for what the
 * check prevents.
 */
const OWNERSHIP_IS_LOAD_BEARING = process.platform === 'darwin';

/**
 * A stable name for "the build that is running right now".
 *
 * Good enough for the job: it has to change whenever the code signature changes
 * and stay put otherwise. A packaged release and a dev run are different
 * identities, and so are two different released versions — which is exactly
 * when an ad-hoc signature changes.
 *
 * It cannot read the real signature, and does not try. Shelling out to
 * `codesign` during boot to answer a question about our own keychain would add
 * a process spawn to the critical path to fix a problem this string already
 * solves.
 */
function buildIdentity() {
  const kind = app.isPackaged ? 'app' : 'dev';

  /**
   * A packaged build carries a unique id stamped in by
   * `scripts/beforepack-build-id.js`.
   *
   * The version number alone is not specific enough. An ad-hoc signature is
   * unique per BUILD, so two builds of the same version are different owners to
   * the Keychain. Fingerprinting as `app-0.1.4` let a rebuilt 0.1.4 think it
   * owned a key saved by an earlier 0.1.4, call into the Keychain, and trigger
   * the password prompt this guard exists to avoid — observed live on
   * 2026-08-09.
   *
   * Read once, at module load, off a file inside the asar. No process spawn and
   * nothing on the boot path that can block.
   */
  if (app.isPackaged) {
    try {
      const stamped = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'build-id.txt'), 'utf8').trim();
      if (stamped) return `${kind}-${app.getVersion()}-${stamped}`;
    } catch (_) {
      // No stamp: an older build, or one packaged without the hook. Fall
      // through to the version, which is coarser but still refuses a key from a
      // different release.
    }
  }

  return `${kind}-${app.getVersion()}`;
}

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.settingsPath = path.join(this.dir, 'settings.json');
    this.threadsPath = path.join(this.dir, 'threads.json');
    this.keyPath = path.join(this.dir, 'key.dat');

    // Shape-checked, not just parse-checked. `_readJson` recovers from
    // unparseable JSON but returns whatever DID parse — so a `threads.json`
    // containing `null` (or `{}`, or `3`) set this.threads to that and the
    // first listThreads() threw on boot, which is exactly the failure the
    // recovery exists to prevent.
    const settings = this._readJson(this.settingsPath, {});
    const threads = this._readJson(this.threadsPath, []);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}),
    };
    this.threads = Array.isArray(threads) ? threads.filter((t) => t && typeof t === 'object') : [];
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
      record = {
        v: 2,
        enc: 'os',
        data: safeStorage.encryptString(value).toString('base64'),
        // Which build wrote this. See `buildIdentity()` and getKey() below —
        // this is what stops a keychain the current build cannot open from
        // being opened at all.
        owner: buildIdentity(),
      };
    } else {
      console.warn('[store] OS encryption unavailable — API key stored in plain text');
      record = { v: 2, enc: 'none', data: Buffer.from(value, 'utf8').toString('base64') };
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

    /**
     * Refuse to touch the keychain when a different build wrote this key.
     *
     * This guard is the fix for the worst bug macOS has produced. On macOS the
     * `safeStorage` secret is a Keychain item whose ACL is bound to the app's
     * CODE SIGNATURE. Handrail is distributed unsigned, so its ad-hoc signature
     * differs from build to build — which means every update, and every move
     * between a dev run and the packaged app, presents a keychain item the
     * running binary is not the owner of.
     *
     * macOS answers that by putting up an authorisation prompt. Handrail sets
     * `LSUIElement`, so at boot it has no window, no Dock icon and no menu bar,
     * and the prompt can end up with nothing to attach to. `decryptString` is
     * synchronous, so the main process blocks inside it — forever, before the
     * overlay is created, before the tray is drawn, before the hotkey is
     * registered. The observable result is an app that "does nothing": a live
     * process, no window, no way in and no way out but Force Quit.
     *
     * Reproduced on 2026-08-09 against the shipped 0.1.3 arm64 build: with
     * key.dat present the app was windowless and helperless; with it moved
     * aside the same binary booted straight into onboarding.
     *
     * So the check happens on OUR data, before the OS is asked anything. A key
     * we cannot prove we own is treated as gone, which sends the user to
     * onboarding to paste it again — three seconds of annoyance instead of an
     * app that never opens again.
     */
    if (record && record.enc === 'os' && OWNERSHIP_IS_LOAD_BEARING && record.owner !== buildIdentity()) {
      console.warn(
        `[store] stored key belongs to a different build (${record.owner || 'unrecorded'} != ` +
        `${buildIdentity()}); not decrypting — the user will be asked for it again`,
      );
      this.keyProblem = 'foreign';
      return null;
    }

    try {
      if (record && (record.v === 1 || record.v === 2)) {
        const buf = Buffer.from(record.data, 'base64');
        this._key = record.enc === 'os' ? safeStorage.decryptString(buf) : buf.toString('utf8');
      } else {
        this._key = safeStorage.decryptString(raw);
      }
      this.keyProblem = null;
      return this._key;
    } catch (err) {
      /**
       * The stored key could not be read.
       *
       * Usually permanent: on Windows the encryption key lives in `Local State`
       * inside userData, and if that is regenerated the blob is orphaned
       * forever. But not always — a keyring that is not ready yet fails exactly
       * the same way, and this used to DELETE the file on any throw at all,
       * which turns a transient failure into permanent data loss.
       *
       * The file is left alone now. Nothing is gained by removing it: `saveKey`
       * overwrites it anyway, the user is sent to onboarding either way, and a
       * failure that turns out to be transient simply recovers on the next
       * launch. `keyProblem` is what onboarding reads to explain itself instead
       * of looking like a fresh install.
       */
      console.warn('[store] stored key could not be read:', err.message);
      this.keyProblem = 'unreadable';
      return null;
    }
  }

  /**
   * Masked tail. The only form of the key the renderer is ever given.
   *
   * The head and tail slices overlap below 13 characters, so a short value was
   * printed almost whole — `OPENROUTER_API_KEY=short` produced the hint
   * `Unknown · short••••hort`. Below that length nothing but the provider is
   * shown; a hint is not worth leaking the thing it is hiding.
   */
  keyHint() {
    const key = this.getKey();
    if (!key) return '';
    const provider = providerOf(key);
    if (key.length < 13) return `${provider} · ••••`;
    return `${provider} · ${key.slice(0, 9)}••••${key.slice(-4)}`;
  }

  // --- threads ------------------------------------------------------------

  listThreads() {
    return this.threads
      // updatedAt is coerced because a hand-edited or half-written threads.json
      // with it missing sorts to NaN and scrambles the whole list.
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt: Number(updatedAt) || 0 }))
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
