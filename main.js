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

  app.on('second-instance', () => {
    if (windows) windows.toggleOverlay();
  });

  app.whenReady().then(() => {
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

    ipc.register({
      store,
      windows,
      turns,
      llm,
      onSetupComplete: () => launchOverlay(),
    });

    // Onboarding runs when there is no key to work with. That is the honest
    // test — a settings flag can say setup is complete while the key it saved
    // has since been revoked or failed to decrypt.
    if (store.getKey()) launchOverlay();
    else windows.showOnboarding();

    registerShortcuts();
    createTray();
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
    const iconPath = path.join(__dirname, 'build', 'icon-32.png');
    const fallback = path.join(__dirname, 'icon.ico');   // packaged apps

    let image = nativeImage.createFromPath(fs.existsSync(iconPath) ? iconPath : fallback);
    if (image.isEmpty()) {
      console.warn('[main] no tray icon found; tray not created');
      return;
    }
    // macOS wants a template image so the tray icon follows the menu bar theme.
    if (process.platform === 'darwin') image = image.resize({ width: 16, height: 16 });

    tray = new Tray(image);
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
  }

  function launchOverlay() {
    if (!windows.overlay) windows.createOverlay();
    windows.overlay.webContents.once('did-finish-load', () => windows.showOverlay());
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
