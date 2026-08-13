/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — windows.
 *
 * Three windows, replacing upstream's four renderer windows plus onboarding:
 *
 *   overlay     the product. Transparent, frameless, always on top, resized by
 *               the renderer as its content changes.
 *   arrow       a click-through pane covering one display, used only to draw
 *               the pointer. Separate from the overlay because it has to cover
 *               a whole screen while the overlay stays small.
 *   onboarding  a one-time real window. It asks for a secret and makes a
 *               privacy promise, neither of which belongs in a 30px strip.
 *
 * Windows are created once and hidden, never destroyed and rebuilt. Rebuilding
 * costs a visible flash on someone else's screen, and the overlay is shown and
 * hidden constantly.
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'renderer');

/**
 * Capture exclusion. On by default; `STEALTH_MODE=false` makes the overlay
 * visible to screen recording so the UI can be screenshotted for design work.
 * The user-facing setting rides on top of the same call.
 */
const STEALTH_DEFAULT = process.env.STEALTH_MODE !== 'false';

/**
 * How long an indicator stays before removing itself.
 *
 * A backstop, not the usual way it goes. An indicator normally leaves because
 * the user dismissed it, the step it belongs to finished, or the next turn
 * replaced it. This exists so one can never be stranded on somebody's screen
 * pointing at a control that has since moved.
 *
 * Raised from 14s: long enough to read, but not long enough to act on while
 * actually doing the thing — and there is a dismiss button now, so the timer no
 * longer has to be the only way out.
 */
const ARROW_DWELL_MS = 45000;

class Windows {
  constructor(store) {
    this.store = store;
    this.overlay = null;
    this.arrow = null;
    this.onboarding = null;
    // Called when the arrow goes away on its own — i.e. the dwell timer. The
    // overlay's "Pointing at it on your screen" badge is driven by an event
    // from main, so an arrow that removes itself silently leaves the badge
    // claiming something that is no longer on screen.
    this.onArrowExpired = null;
  }

  // --- overlay ------------------------------------------------------------

  createOverlay() {
    const bounds = this._restoreOverlayBounds();

    this.overlay = new BrowserWindow({
      ...bounds,
      width: 676,
      height: 92,
      transparent: true,
      frame: false,
      // Created resizable, then locked. Windows silently clamps a
      // non-resizable window to the work area, which costs the taskbar strip —
      // and the overlay is resized by the renderer constantly anyway.
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed, like the other two windows. This was false, which meant
        // the ONE window that renders model output was also the one window
        // opting out of Chromium's sandbox. The preload only uses contextBridge
        // and ipcRenderer, both of which work sandboxed, so nothing needed it.
        spellcheck: false,
      },
    });

    this.overlay.setAlwaysOnTop(true, 'screen-saver');
    this.overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.applyStealth(this.store.getSettings().stealth);

    this.overlay.loadFile(path.join(RENDERER, 'overlay.html'));

    // Remember where the user put it. Position persistence is cheap and its
    // absence is immediately annoying on a window you reposition by hand.
    //
    // Both events, and debounced. `moved` fires once at the end of a drag, but
    // ONLY for a drag — a window moved by setBounds, by the OS reflowing after
    // a display change, or by a snap never fires it, and the position was
    // silently lost. `move` fires for all of those, and also continuously
    // during a drag, which is why it has to be debounced: writing settings.json
    // synchronously on every mouse tick would make dragging stutter.
    let moveTimer = null;
    const remember = () => {
      if (!this.overlay || this.overlay.isDestroyed()) return;
      const b = this.overlay.getBounds();
      this.store.setSettings({ overlayPos: { x: b.x, y: b.y } });
    };
    const rememberSoon = () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(remember, 400);
    };
    this.overlay.on('move', rememberSoon);
    this.overlay.on('moved', rememberSoon);
    this.overlay.on('closed', () => clearTimeout(moveTimer));

    this.overlay.on('closed', () => { this.overlay = null; });
    return this.overlay;
  }

  _restoreOverlayBounds() {
    const saved = this.store.getSettings().overlayPos;
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      // Only honour a saved position if it is still on a connected display.
      // Monitors get unplugged, and a window restored onto a screen that no
      // longer exists is invisible with no way to get it back.
      const onScreen = screen.getAllDisplays().some((d) => {
        const b = d.bounds;
        return saved.x >= b.x - 40 && saved.x < b.x + b.width - 40 &&
               saved.y >= b.y - 40 && saved.y < b.y + b.height - 40;
      });
      if (onScreen) return { x: saved.x, y: saved.y };
    }

    // Default: horizontally centred, a third of the way down the active screen.
    const wa = cursor.workArea;
    return {
      x: Math.round(wa.x + (wa.width - 676) / 2),
      y: Math.round(wa.y + wa.height * 0.28),
    };
  }

  /**
   * Resize to the renderer's measured content.
   *
   * Width and height only — the origin is left alone so the window does not
   * walk across the screen as the user's answer grows.
   */
  resizeOverlay({ w, h }) {
    if (!this.overlay || this.overlay.isDestroyed()) return;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;

    const b = this.overlay.getBounds();
    const width = Math.max(320, Math.min(1200, Math.round(w)));
    const height = Math.max(60, Math.min(900, Math.round(h)));
    if (b.width === width && b.height === height) return;

    this.overlay.setBounds({ x: b.x, y: b.y, width, height }, false);
  }

  showOverlay() {
    if (!this.overlay || this.overlay.isDestroyed()) return;
    // showInactive: taking focus from the app the user is being taught is
    // exactly the wrong behaviour for an assistant that sits on top of it.
    this.overlay.showInactive();
    this.overlay.setAlwaysOnTop(true, 'screen-saver');
  }

  hideOverlay() {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.hide();
  }

  toggleOverlay() {
    if (!this.overlay || this.overlay.isDestroyed()) return;
    if (this.overlay.isVisible()) this.hideOverlay();
    else {
      this.showOverlay();
      this.overlay.focus();
    }
  }

  applyStealth(enabled) {
    const on = STEALTH_DEFAULT && enabled !== false;
    for (const win of [this.overlay, this.arrow]) {
      if (win && !win.isDestroyed()) win.setContentProtection(on);
    }
  }

  /**
   * Keep Handrail out of its own screenshots — without hiding anything.
   *
   * The first build hid the overlay, captured, then showed it again. That works,
   * and it also means the UI visibly disappears and reappears on every single
   * prompt, and again for every arrow and every completion check. It read as the
   * app glitching.
   *
   * Content protection does the same job invisibly: on Windows it sets
   * WDA_EXCLUDEFROMCAPTURE, on macOS NSWindowSharingNone, and either way
   * desktopCapturer simply does not see the window. Nothing moves on screen.
   *
   * When stealth is on — the default — the windows are already excluded, so
   * this is a no-op and costs nothing.
   *
   * Refcounted, because captures overlap: a watch tick and a `_pointAtTarget`
   * can be in flight at the same moment. Each used to restore independently, so
   * whichever finished first dropped protection while the other was still
   * capturing — and Handrail appeared in the very frame it was meant to be
   * absent from. Restore is idempotent so a double call cannot drive the count
   * negative.
   *
   * Returns a function that restores the user's actual setting.
   */
  /**
   * Where Handrail's own windows are, so a capture can blank them out.
   *
   * This REPLACES `excludeFromCapture()`, which turned content protection on
   * before each capture and off after. Content protection is also what removes
   * a window from a screen share, so on a Google Meet call with stealth
   * switched off the overlay blinked out and back on every question — flicker
   * for the viewer, perfectly static locally, because content protection does
   * not affect the local display.
   *
   * Content protection is now set once from the user's stealth setting and
   * never toggled. Self-exclusion is done by painting these rectangles black in
   * the captured pixels; see capture.js § maskRegions.
   */
  selfWindowBounds() {
    return [this.overlay, this.arrow]
      .filter((w) => w && !w.isDestroyed() && w.isVisible())
      .map((w) => w.getBounds());
  }

  // --- arrow --------------------------------------------------------------

  /**
   * Draw the pointer, or clear it.
   *
   * The window is created lazily and moved to whichever display it needs to
   * cover, rather than one per screen — there is only ever one arrow.
   */
  showArrow(payload) {
    clearTimeout(this._arrowTimer);

    if (!payload) {
      if (this.arrow && !this.arrow.isDestroyed()) this.arrow.hide();
      return;
    }

    // The window covers only the arrow and its label, not the display. A
    // full-screen transparent always-on-top layer has to be recomposited
    // continuously, and on integrated graphics that alone makes the whole
    // machine feel like it is dragging. See geometry.js § arrowLayout.
    const region = payload.layout.region;
    const b = {
      x: payload.display.bounds.x + region.x,
      y: payload.display.bounds.y + region.y,
      width: region.width,
      height: region.height,
    };

    if (!this.arrow || this.arrow.isDestroyed()) {
      this.arrow = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        transparent: true,
        frame: false,
        resizable: true,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          preload: path.join(ROOT, 'preload-arrow.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.arrow.setAlwaysOnTop(true, 'screen-saver');
      this.arrow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // The arrow points at a real control, so the user must be able to click
      // that control straight through it.
      //
      // Forwarding is back, but only because the window is now a few hundred
      // pixels rather than the whole display. Full-screen forwarding meant
      // Chromium synthesised a mouse event for every cursor movement anywhere
      // on screen, which was the single biggest cause of the lag users felt.
      // Over a small region it is cheap, and it is what lets the label carry a
      // dismiss button while every other pixel stays click-through.
      this.arrow.setIgnoreMouseEvents(true, { forward: true });
      this.arrow.loadFile(path.join(RENDERER, 'arrow.html'));
      this.arrow.on('closed', () => { this.arrow = null; });
      this.applyStealth(this.store.getSettings().stealth);
    }

    // setBounds after creation, not in the constructor — see the overlay's
    // note about Windows clamping to the work area.
    this.arrow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });

    const send = () => {
      if (this.arrow && !this.arrow.isDestroyed()) {
        this.arrow.webContents.send('hr:arrow', payload);
        this.arrow.showInactive();
        this.arrow.setAlwaysOnTop(true, 'screen-saver');
      }
    };

    if (this.arrow.webContents.isLoading()) this.arrow.webContents.once('did-finish-load', send);
    else send();

    // Take itself away. Guidance that has been read becomes clutter, and the
    // arrow has no clickable dismiss of its own precisely because it must stay
    // click-through — the user has to be able to click what it points at. The
    // step's own controls in the overlay remain the explicit way to stop it.
    this._arrowTimer = setTimeout(() => {
      if (this.arrow && !this.arrow.isDestroyed()) this.arrow.hide();
      if (this.onArrowExpired) this.onArrowExpired();
    }, ARROW_DWELL_MS);
  }

  /**
   * Accept clicks on the indicator, or return to click-through.
   *
   * Driven by the renderer as the cursor crosses the label's edge. Electron's
   * ignore-mouse-events is window-wide, so toggling it is the only way to have
   * exactly one clickable region on an otherwise transparent pane.
   */
  setArrowInteractive(on) {
    if (!this.arrow || this.arrow.isDestroyed()) return;
    this.arrow.setIgnoreMouseEvents(!on, { forward: true });
  }

  // --- onboarding ---------------------------------------------------------

  showOnboarding() {
    if (this.onboarding && !this.onboarding.isDestroyed()) {
      this.onboarding.show();
      this.onboarding.focus();
      return this.onboarding;
    }

    this.onboarding = new BrowserWindow({
      width: 560,
      height: 620,
      resizable: false,
      maximizable: false,
      frame: false,
      transparent: true,
      show: false,
      center: true,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.onboarding.loadFile(path.join(RENDERER, 'onboarding.html'));
    this.onboarding.once('ready-to-show', () => {
      this.onboarding.show();
      this.onboarding.focus();
    });
    this.onboarding.on('closed', () => { this.onboarding = null; });
    return this.onboarding;
  }

  closeOnboarding() {
    if (this.onboarding && !this.onboarding.isDestroyed()) this.onboarding.close();
  }

  // --- lifecycle ----------------------------------------------------------

  destroyAll() {
    for (const win of [this.overlay, this.arrow, this.onboarding]) {
      if (win && !win.isDestroyed()) win.destroy();
    }
    this.overlay = this.arrow = this.onboarding = null;
  }
}

module.exports = { Windows, STEALTH_DEFAULT };
