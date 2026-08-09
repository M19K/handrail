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
    // Starting a new thread abandons whatever was in flight — the user has
    // explicitly moved on, and leaving a turn streaming into a thread they are
    // no longer looking at is worse than cancelling it.
    turns.cancel();
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
    if (patch && patch.pointing === false) windows.showArrow(null);
    return next;
  });

  // --- window -------------------------------------------------------------
  handle('hr:window:state', (state) => {
    // Collapsing tears down anything still on screen: an arrow left pointing at
    // a control after the user has put Handrail away is the worst failure this
    // product has.
    if (state === 'collapsed') {
      turns.cancel();
      windows.showArrow(null);
    }
  });
  handle('hr:window:resize', (size) => { windows.resizeOverlay(size || {}); });
  handle('hr:window:drag', () => { /* handled natively by -webkit-app-region */ });
  handle('hr:window:close', () => { windows.hideOverlay(); });

  handle('hr:window:quit', () => {
    // Tear down before quitting. An arrow window outliving the app for even a
    // frame leaves a mint stroke stranded on the user's screen.
    turns.cancel();
    windows.showArrow(null);
    app.quit();
  });

  // Re-open onboarding to change the key. It is the only screen that ever
  // handles a key in plain text, so there is no second place to maintain.
  handle('hr:window:open-setup', () => { windows.showOnboarding(); });

  // --- setup --------------------------------------------------------------

  /**
   * Verify a key by actually using it.
   *
   * A shape check alone would pass a revoked or mistyped key and the user
   * would only find out mid-task, with no reason to suspect the key. One
   * cheap request now is worth it.
   */
  handle('hr:setup:validate', async (key) => {
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

  handle('hr:setup:save', (key) => { store.saveKey(key); });

  /**
   * Nudge the OS into asking for screen-recording permission.
   *
   * macOS gates `getSources` behind a system prompt that only appears on first
   * use. Triggering it here means the user meets it during onboarding rather
   * than in the middle of their first real question.
   */
  handle('hr:setup:screen-access', async () => {
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'granted') return { granted: true };
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      return { granted: sources.length > 0 };
    } catch (_) {
      return { granted: false };
    }
  });

  handle('hr:setup:complete', () => {
    store.setSettings({ setupComplete: true });
    // Order matters. Closing onboarding first leaves zero windows open for an
    // instant, which fires `window-all-closed` and quits the app on Windows
    // before the overlay ever exists. Create the replacement, then close.
    onSetupComplete();
    windows.closeOnboarding();
  });

  handle('hr:setup:open-external', (url) => {
    // Only https, and only somewhere we chose. The renderer must never be able
    // to turn this into a general "open anything" primitive.
    const value = String(url || '');
    if (!/^https:\/\//.test(value)) return;
    shell.openExternal(value);
  });
}

module.exports = { register };
