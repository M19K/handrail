/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — IPC handlers.
 *
 * The main-process half of docs/IPC.md. Every `hr:*` channel is registered
 * here and nowhere else, so the whole surface can be read in one file.
 *
 * Upstream spread ~90 channels across main.js, three window modules and two
 * preload bridges. Finding where a message was handled meant grepping.
 */

const { app, ipcMain, shell, systemPreferences, desktopCapturer } = require('electron');
const { providerOf } = require('./store');
const { friendly } = require('./turn');

function register({ store, windows, turns, llm, onSetupComplete }) {
  /** Wrap a handler so a thrown error reaches the renderer as a readable string. */
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        console.error(`[ipc] ${channel} failed:`, err.message);
        throw new Error(friendly(err));
      }
    });
  };

  // --- turns --------------------------------------------------------------
  handle('hr:ask', (payload) => turns.ask(payload || {}));
  handle('hr:cancel', () => { turns.cancel(); });

  // --- steps --------------------------------------------------------------
  handle('hr:step:complete', (taskId, index) => turns.completeStep(taskId, index));
  handle('hr:step:reopen', (taskId, index) => turns.reopenStep(taskId, index));

  // --- threads ------------------------------------------------------------
  handle('hr:threads:list', () => store.listThreads());
  handle('hr:threads:open', (id) => store.getThread(id));
  handle('hr:threads:create', () => {
    // A new thread is a fresh start: the checklist, the arrow and anything
    // still in flight all belong to the thread being left behind.
    turns.reset();
    return store.createThread();
  });
  handle('hr:threads:rename', (id, title) => { store.renameThread(id, title); });
  handle('hr:threads:remove', (id) => { store.removeThread(id); });

  // --- settings -----------------------------------------------------------
  handle('hr:settings:get', () => store.getSettings());
  handle('hr:settings:set', (patch) => {
    const next = store.setSettings(patch);
    // Applied immediately rather than on restart. A toggle that needs a restart
    // to take effect reads as broken.
    if (patch && 'stealth' in patch) windows.applyStealth(next.stealth);
    if (patch && patch.watching === false) turns.stopWatching();
    if (patch && patch.pointing === false) turns.clearArrow();
    return next;
  });

  /**
   * The model list, fetched live from OpenRouter.
   *
   * Hard-coding it meant the choice was limited to whatever four ids happened
   * to be known when the dropdown was written — and a hard-coded id that gets
   * renamed or retired fails at request time with a provider error, which reads
   * as Handrail being broken.
   *
   * Filtered to models that accept images, because Handrail's whole premise is
   * reading the screen and a text-only model fails in a way that looks like the
   * app being stupid rather than misconfigured. The endpoint needs no key.
   */
  let modelCache = null;
  handle('hr:models:list', async () => {
    if (modelCache) return modelCache;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      const body = await res.json();

      const models = (body.data || [])
        .filter((m) => {
          const arch = m.architecture || {};
          const inputs = arch.input_modalities || [];
          const outputs = arch.output_modalities || ['text'];

          // Must read images — that is the whole premise.
          if (!(inputs.includes('image') || /image/.test(arch.modality || ''))) return false;
          // Must answer in text. Image-generation models accept a picture and
          // reply with another picture, which is not an answer.
          if (!outputs.includes('text')) return false;
          // Batch endpoints are queued and asynchronous. Offering one in an
          // interactive overlay is offering a model that never replies.
          if (/:batch$/.test(m.id)) return false;

          return true;
        })
        .map((m) => ({
          id: m.id,
          name: m.name || m.id,
          // Per million tokens, which is the unit people actually compare.
          inPrice: Number(m.pricing && m.pricing.prompt) * 1e6 || 0,
          outPrice: Number(m.pricing && m.pricing.completion) * 1e6 || 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (models.length) modelCache = models;
      return models;
    } catch (err) {
      // Offline, or the endpoint changed shape. The renderer falls back to a
      // small built-in list rather than showing an empty dropdown.
      console.warn('[ipc] could not fetch model list:', err.message);
      return [];
    } finally {
      clearTimeout(timer);
    }
  });

  // --- window -------------------------------------------------------------
  handle('hr:window:state', (state) => {
    // Collapsing tears down anything still on screen: an arrow left pointing at
    // a control after the user has put Handrail away is the worst failure this
    // product has.
    if (state === 'collapsed') {
      // reset, not cancel: putting Handrail away finishes with the task too.
      turns.reset();
    }
  });
  handle('hr:window:resize', (size) => { windows.resizeOverlay(size || {}); });
  handle('hr:window:drag', () => { /* handled natively by -webkit-app-region */ });
  handle('hr:window:close', () => { windows.hideOverlay(); });

  handle('hr:window:quit', () => {
    // Tear down before quitting. An arrow window outliving the app for even a
    // frame leaves a mint stroke stranded on the user's screen.
    turns.reset();
    app.quit();
  });

  // Re-open onboarding to change the key. It is the only screen that ever
  // handles a key in plain text, so there is no second place to maintain.
  handle('hr:window:open-setup', () => { windows.showOnboarding(); });

  // --- the indicator ------------------------------------------------------
  //
  // ipcMain.on rather than handle: these are one-way and the first fires as the
  // cursor crosses the label's edge, so a promise per message would be overhead
  // for nothing.
  ipcMain.on('hr:arrow:interactive', (_event, on) => windows.setArrowInteractive(on));

  ipcMain.on('hr:arrow:dismiss', () => {
    // Dismissing the indicator dismisses only the indicator. The checklist and
    // the watching loop are what the user is actually doing; tearing those down
    // because they closed a label would be a surprising amount of collateral.
    //
    // Via turns, not windows.showArrow, so the overlay's "Pointing at it on
    // your screen" badge is told too — it used to keep claiming an arrow the
    // user had just closed.
    turns.clearArrow();
  });

  // --- setup --------------------------------------------------------------
  //
  // One preload serves both windows, so the overlay — the window that renders
  // model output — could otherwise call `saveKey` and overwrite the user's key,
  // or `complete` and flip settings. It has no use for either. `setup` handlers
  // therefore verify the sender is the onboarding window rather than trusting
  // that only onboarding ever calls them.
  const fromOnboarding = (event) => {
    const win = windows.onboarding;
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  };

  const handleSetup = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromOnboarding(event)) {
        console.warn(`[ipc] ${channel} refused: sender is not the onboarding window`);
        throw new Error('Not available here.');
      }
      try {
        return await fn(...args);
      } catch (err) {
        console.error(`[ipc] ${channel} failed:`, err.message);
        throw new Error(friendly(err));
      }
    });
  };

  /**
   * Verify a key by actually using it.
   *
   * A shape check alone would pass a revoked or mistyped key and the user
   * would only find out mid-task, with no reason to suspect the key. One
   * cheap request now is worth it.
   */
  handleSetup('hr:setup:validate', async (key) => {
    const value = String(key || '').trim();
    const provider = providerOf(value);
    if (provider === 'Unknown') {
      return { valid: false, provider, error: "That doesn't look like an API key." };
    }

    try {
      await llm.probe(value);
      return { valid: true, provider };
    } catch (err) {
      return { valid: false, provider, error: friendly(err) };
    }
  });

  handleSetup('hr:setup:save', (key) => { store.saveKey(key); });

  /**
   * Nudge the OS into asking for screen-recording permission.
   *
   * macOS gates `getSources` behind a system prompt that only appears on first
   * use. Triggering it here means the user meets it during onboarding rather
   * than in the middle of their first real question.
   */
  handleSetup('hr:setup:screen-access', async () => {
    if (process.platform !== 'darwin') {
      // No OS gate to satisfy. Prove capture works rather than claiming it.
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        return { granted: sources.length > 0, status: 'granted' };
      } catch (_) {
        return { granted: false, status: 'denied' };
      }
    }

    /**
     * macOS is the only platform where this question has a real answer, and
     * `getSources()` is not it.
     *
     * The old code returned `sources.length > 0`. On macOS `getSources()`
     * returns a source whether or not screen recording is permitted — denied,
     * you get the entry with a blank picture. So it reported "granted" every
     * time, on a machine that had never been asked, and onboarding's "your OS
     * has not granted access yet" branch was unreachable. The failure surfaced
     * later as "Failed to get sources" in the middle of the user's first real
     * question.
     *
     * `getMediaAccessStatus('screen')` is the authority. `getSources()` is
     * still called, but only for its side effect: it is what makes macOS put
     * the permission prompt up the first time, which is the whole reason this
     * runs during onboarding instead of mid-task.
     */
    const before = systemPreferences.getMediaAccessStatus('screen');
    if (before === 'granted') {
      // Granted at OS level does not mean THIS process can capture: the
      // decision is bound at launch. Confirm, and if it fails say plainly that
      // a restart is what fixes it rather than looping the user on Try again.
      try {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        return { granted: true, status: 'granted' };
      } catch (_) {
        return { granted: false, status: 'granted', needsRestart: true };
      }
    }

    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    } catch (_) { /* being refused here is a legitimate answer, not an error */ }

    const after = systemPreferences.getMediaAccessStatus('screen');
    // macOS records the grant, but the running process keeps the access it was
    // launched with — so answering the prompt still needs a restart.
    return { granted: false, status: after, needsRestart: after === 'granted' };
  });

  /**
   * Open the exact System Settings pane the permission lives in.
   *
   * "Allow it in System Settings" is not an instruction a non-technical person
   * can follow — Privacy & Security has thirty rows and the one they need is
   * called "Screen & System Audio Recording", which is not what the app calls
   * it. This puts them on the right screen.
   */
  handleSetup('hr:setup:open-screen-settings', () => {
    if (process.platform !== 'darwin') return { opened: false };
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { opened: true };
  });

  /**
   * Restart Handrail, because on macOS that is the only way to pick up a
   * screen-recording permission granted after launch.
   */
  handleSetup('hr:setup:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  handleSetup('hr:setup:complete', () => {
    store.setSettings({ setupComplete: true });
    // Order matters. Closing onboarding first leaves zero windows open for an
    // instant, which fires `window-all-closed` and quits the app on Windows
    // before the overlay ever exists. Create the replacement, then close.
    onSetupComplete();
    windows.closeOnboarding();
  });

  /**
   * Open one of a fixed set of destinations in the user's browser.
   *
   * Takes a NAME, not a URL. The first version took a URL and checked only that
   * it started with https, which made it a general "open any website" primitive
   * for anything running in a renderer — and the same preload is loaded into the
   * overlay, the window that renders model output. A name cannot be pointed
   * somewhere we did not choose.
   */
  const DESTINATIONS = {
    'get-key': 'https://openrouter.ai/keys',
  };

  handleSetup('hr:setup:open-external', (name) => {
    const url = DESTINATIONS[String(name || '')];
    if (!url) {
      console.warn(`[ipc] refused to open unknown destination: ${name}`);
      return;
    }
    shell.openExternal(url);
  });
}

module.exports = { register };
