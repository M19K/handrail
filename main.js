/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified from OpenCluely (TechyCSR, Apache-2.0). This file has been changed;
 * see NOTICE and `git diff 7909792..HEAD` for what changed.
 */
/**
 * Handrail — application entry point.
 *
 * A cross-platform desktop overlay that sees your screen and walks you through
 * complex software, step by step.
 *
 * Fork of OpenCluely (TechyCSR), Apache-2.0. This file is a complete rewrite:
 * upstream's main.js was ~2,000 lines coordinating four renderer windows, a
 * speech pipeline, Whisper installation and interview-specific skill routing.
 * None of that is Handrail. What remains is small enough to read.
 *
 *   src/main/store.js    settings, threads, key
 *   src/main/llm.js      the four kinds of model request
 *   src/main/capture.js  screen capture
 *   src/main/turn.js     turn orchestration and the step-watching loop
 *   src/main/windows.js  overlay, arrow, onboarding
 *   src/main/ipc.js      every hr:* channel
 */

require('dotenv').config();

const { app, globalShortcut, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./src/main/store');
const { Llm } = require('./src/main/llm');
const { Windows } = require('./src/main/windows');
const { TurnController } = require('./src/main/turn');
const ipc = require('./src/main/ipc');
const log = require('./src/main/log');

// Process-name masking, inherited from upstream and kept deliberately: the
// overlay is excluded from screen capture, and a process list entry reading
// "Handrail" would give it away in the one place someone would look.
app.setName('Handrail');
process.title = 'Handrail';

// A second instance would fight the first for the global hotkey and the store.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  let store, windows, turns, llm, tray;

  /**
   * Someone launched Handrail while it was already running.
   *
   * Show it. This used to toggle, which means double-clicking the desktop
   * shortcut while the overlay was on screen made it disappear — the icon you
   * just clicked to summon the app is the thing that dismissed it, and there is
   * nothing on screen to explain that. Toggling is right for the tray icon and
   * for the hotkey, because those are switches. Launching is not a switch.
   */
  app.on('second-instance', () => {
    if (!windows) return;
    if (!store || !store.getKey()) {
      windows.showOnboarding();
      return;
    }
    launchOverlay();
    if (windows.overlay && !windows.overlay.isDestroyed()) windows.overlay.focus();
  });

  app.whenReady().then(() => {
    log.start(app.getPath('userData'), {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: `${process.platform} ${process.arch}`,
      electron: process.versions.electron,
    });
    log.captureConsole();

    // A background app with no Dock icon in production and one in development
    // is two different products to test. LSUIElement gives the packaged build
    // no Dock presence; this gives the same to `npm start`, so what gets tested
    // is what gets shipped.
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    store = new Store();
    llm = new Llm(() => store.getKey(), () => store.getSettings().model);
    windows = new Windows(store);

    turns = new TurnController({
      llm,
      store,
      getOverlay: () => windows.overlay,
      emit: (event) => {
        const win = windows.overlay;
        if (win && !win.isDestroyed()) win.webContents.send('hr:turn', event);
      },
      point: (payload) => windows.showArrow(payload),
      excludeFromCapture: () => windows.excludeFromCapture(),
    });

    // The arrow's 45s dwell timer hides it without anyone asking. Tell the
    // overlay, or its "Pointing at it on your screen" badge outlives the arrow.
    windows.onArrowExpired = () => turns.emit({ type: 'point', rect: null });

    ipc.register({
      store,
      windows,
      turns,
      llm,
      onSetupComplete: () => launchOverlay(),
    });

    /**
     * The tray and the hotkeys come FIRST, before anything that reads the key.
     *
     * Order is load-bearing now. It used to be the other way round, and the
     * consequence was the worst failure this app has shipped: `store.getKey()`
     * blocked inside a macOS keychain call, and because that happened before
     * these two lines there was no tray icon, no global hotkey and no window.
     * A live process with no way to reach it and no way to quit it.
     *
     * `store.js` fixes the block itself. This fixes the blast radius: whatever
     * else goes wrong below, Handrail is already reachable by hotkey and
     * already has a visible tray icon with a working Quit in it.
     */
    registerShortcuts();
    createTray();

    // Onboarding runs when there is no key to work with. That is the honest
    // test — a settings flag can say setup is complete while the key it saved
    // has since been revoked or failed to decrypt.
    try {
      if (store.getKey()) launchOverlay();
      else windows.showOnboarding();
    } catch (err) {
      // Never end a boot with nothing on screen. If deciding which window to
      // open is what failed, open the one that can recover — onboarding can
      // re-enter a key, and it carries the quit button.
      console.error('[main] could not open the first window:', err);
      windows.showOnboarding();
    }
  });

  /**
   * System tray.
   *
   * The overlay is frameless, has no menu bar and sets `skipTaskbar`, so before
   * this existed the only way to quit was Task Manager. The bar has a visible
   * quit button now, but that is no help when the overlay is hidden or the user
   * has forgotten the shortcut — the tray is the thing you can always find.
   */
  function createTray() {
    /**
     * macOS and Windows want genuinely different artwork, not two sizes of one.
     *
     * macOS  a TEMPLATE image — alpha only, no colour. The menu bar re-tints the
     *        silhouette per theme. `assets/trayTemplate.png` is drawn for this
     *        by `scripts/make-tray-icons.js`, and `nativeImage` picks up the
     *        `@2x` file beside it on its own.
     *
     *        0.1.3 pointed this at the full app icon and called
     *        `setTemplateImage(true)` on it. That icon is 98% opaque, so the
     *        template was a filled blob and the mark was invisible in the menu
     *        bar. Colour art can never be a template, at any size.
     *
     * Windows the colour mark, at 32px. Falling back to the 256x256 .ico works,
     *        but Windows squeezes it into a 16px slot and the mark turns to
     *        mush — a good way to be invisible in a tray full of other icons.
     */
    const isMac = process.platform === 'darwin';
    const candidates = isMac
      ? [path.join(__dirname, 'assets', 'trayTemplate.png')]
      : [
        ...['32', '16'].flatMap((s) => [
          path.join(__dirname, 'assets', `tray-${s}.png`),   // packaged
          path.join(__dirname, 'build', `icon-${s}.png`),    // running from source
        ]),
        path.join(__dirname, 'icon.ico'),
      ];

    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      // Loud, because of what it cost last time. The packaged 0.1.3 mac build
      // hit this line — `build.files` did not ship the artwork — and with
      // LSUIElement also removing the Dock icon, the app had no visible
      // presence anywhere in the system. `npm test` now asserts the files
      // exist and are listed in `build.files`, so this should be unreachable.
      console.error(
        `[main] NO TRAY ICON FOUND — looked in: ${candidates.join(', ')}. ` +
        'The app will have no menu bar presence. This is a packaging bug.',
      );
      return;
    }

    let image = nativeImage.createFromPath(found);
    if (image.isEmpty()) {
      console.error(`[main] tray icon at ${found} would not decode; tray not created`);
      return;
    }
    if (isMac) {
      // Already 16x16 with a 32x32 @2x beside it, so no resize: scaling a
      // template down is what softened the mark before.
      image.setTemplateImage(true);
    }

    try {
      tray = new Tray(image);
    } catch (err) {
      // A tray failure must not take the app down with it — losing the tray is
      // survivable, losing the overlay is not.
      console.warn('[main] could not create tray:', err.message);
      return;
    }
    tray.setToolTip('Handrail');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Handrail', click: () => { launchOverlay(); windows.overlay.focus(); } },
      { label: 'Hide', click: () => windows.hideOverlay() },
      { type: 'separator' },
      { label: 'Settings…', click: () => windows.showOnboarding() },
      { type: 'separator' },
      {
        label: 'Quit Handrail',
        click: () => {
          if (turns) turns.reset();
          app.quit();
        },
      },
    ]));

    // Clicking the icon itself is what most people try first.
    tray.on('click', () => windows.toggleOverlay());

    console.log(`[main] tray created from ${found}`);
  }

  /**
   * The overlay is created once and never destroyed, so `did-finish-load` fires
   * exactly once — on creation. Attaching a listener on every call (tray "Show
   * Handrail", onSetupComplete, activate) added one that could never fire, and
   * eleven of them produced a MaxListenersExceededWarning.
   */
  function launchOverlay() {
    if (!windows.overlay) {
      windows.createOverlay();
      windows.overlay.webContents.once('did-finish-load', () => windows.showOverlay());
    }
    if (!windows.overlay.webContents.isLoading()) windows.showOverlay();
  }

  /**
   * Two shortcuts, both global.
   *
   * Toggle has to be global — the whole point is reaching Handrail without
   * leaving the app you are stuck in. Escape-to-dismiss is handled in the
   * renderer, where it can tell the three states apart.
   */
  function registerShortcuts() {
    const toggle = process.platform === 'darwin' ? 'Command+Shift+H' : 'Control+Shift+H';
    if (!globalShortcut.register(toggle, () => windows.toggleOverlay())) {
      console.warn(`[main] could not register ${toggle} — another app has it`);
    }

    // A dedicated panic key. If the overlay is ever stuck visible during a
    // screen share, hunting for the right window is not an option.
    const hide = process.platform === 'darwin' ? 'Command+Shift+Escape' : 'Control+Shift+Escape';
    globalShortcut.register(hide, () => {
      turns.reset();
      windows.hideOverlay();
    });
  }

  // The overlay is a background utility. Closing its window is "put it away",
  // not "quit" — quitting is explicit, from the pill's menu or the tray.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && store && store.getKey()) launchOverlay();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (turns) turns.reset();
  });

  // The renderer has no business navigating anywhere. Blocking it here means a
  // prompt-injected link in a model answer cannot turn the overlay into a
  // browser pointed at somebody else's site.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) event.preventDefault();
    });
  });
}
