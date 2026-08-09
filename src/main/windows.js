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

const { BrowserWindow, screen, app } = require('electron');
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
 * How long an arrow stays before removing itself.
 *
 * Long enough to find the control it points at, short enough that it does not
 * become permanent furniture on the user's screen. The step it belongs to stays
 * highlighted in the overlay either way, so nothing is lost when it goes.
 */
const ARROW_DWELL_MS = 14000;

class Windows {
  constructor(store) {
    this.store = store;
    this.overlay = null;
    this.arrow = null;
    this.onboarding = null;
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
        // The overlay sits over other people's software; it has no business
        // navigating anywhere or opening windows.
        sandbox: false,
        spellcheck: false,
      },
    });

    this.overlay.setAlwaysOnTop(true, 'screen-saver');
    this.overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.applyStealth(this.store.getSettings().stealth);

    this.overlay.loadFile(path.join(RENDERER, 'overlay.html'));

    // Remember where the user put it. Position persistence is cheap and its
    // absence is immediately annoying on a window you reposition by hand.
    const remember = () => {
      if (!this.overlay || this.overlay.isDestroyed()) return;
      const b = this.overlay.getBounds();
      this.store.setSettings({ overlayPos: { x: b.x, y: b.y } });
    };
    this.overlay.on('moved', remember);

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
      // Deliberately WITHOUT `forward: true`. Forwarding makes Chromium
      // synthesise and dispatch a mouse event into this window for every single
      // cursor movement anywhere it covers — which was the single biggest cause
      // of the lag users felt while an arrow was on screen. Nothing in here
      // reacts to the mouse, so there is nothing to forward.
      this.arrow.setIgnoreMouseEvents(true);
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
    }, ARROW_DWELL_MS);
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
