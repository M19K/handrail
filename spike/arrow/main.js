/**
 * Arrow spike — Electron entry point.
 *
 * GO/NO-GO GATE for Handrail's headline feature: can we screenshot the real
 * screen, ask a vision model where a control is, and draw an arrow that
 * actually lands on it — correctly, on a scaled display, on any monitor?
 *
 * Deliberately standalone. It does not import main.js, window.manager.js or any
 * of the four renderer windows. If the answer is no, this directory gets
 * deleted and nothing else has to be unpicked.
 *
 * Usage:
 *   npm run spike:arrow -- "the Save button"
 *   npm run spike:arrow -- --dry-run           # no API call, fixed test boxes
 *   npm run spike:arrow -- --display=1 "File menu"
 *
 * --dry-run is the point of this file existing before the API key does: it
 * exercises capture, display selection, coordinate math, window placement and
 * drawing end to end, so the only thing left to prove once the key lands is the
 * model's accuracy.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { app, BrowserWindow, desktopCapturer, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  parseBox,
  isBoxSane,
  assertCaptureMatchesDisplay,
  boxToScreenRect,
  nativeCaptureSize,
} = require('../../src/main/geometry');
const { locateControl } = require('./vision');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(argv.indexOf('--') + 1 || 2);
  const opts = { dryRun: false, displayIndex: null, target: null, holdMs: 20000 };
  const positional = [];

  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--display=')) opts.displayIndex = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--hold=')) opts.holdMs = parseInt(a.split('=')[1], 10);
    else if (!a.startsWith('--')) positional.push(a);
  }

  opts.target = positional.join(' ').trim() || null;
  return opts;
}

const OPTS = parseArgs(process.argv);

// Everything the spike writes goes to one dated folder so a run can be
// inspected afterwards — the screenshot the model actually saw matters as much
// as the box it returned.
const OUT_DIR = path.join(os.tmpdir(), 'handrail-arrow-spike');

function log(...parts) {
  console.log('[spike]', ...parts);
}

// ---------------------------------------------------------------------------
// Display selection
// ---------------------------------------------------------------------------

/**
 * In the product this is "the display the overlay window is on". The spike has
 * no overlay yet, so the cursor stands in for it — same intent, and it makes
 * multi-monitor testing a matter of moving the mouse before launching.
 */
function chooseDisplay() {
  const displays = screen.getAllDisplays();

  if (Number.isInteger(OPTS.displayIndex)) {
    const picked = displays[OPTS.displayIndex];
    if (!picked) throw new Error(`--display=${OPTS.displayIndex} but only ${displays.length} display(s) present`);
    return picked;
  }

  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture one display at native pixel resolution.
 *
 * Two things this does that capture.service.js does not, both of which matter
 * for the arrow:
 *
 *  1. Requests scaleFactor-multiplied dimensions, so a 150%-scaled panel is
 *     captured at 1920x1080 rather than 1280x720. Small buttons stay legible.
 *  2. Matches the source to the display by `display_id` and only falls back to
 *     the size heuristic. Two identical monitors defeat the size heuristic
 *     completely, and it would pick the wrong screen silently.
 */
async function captureDisplay(display) {
  const native = nativeCaptureSize(display);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: native,
  });

  if (!sources.length) throw new Error('desktopCapturer returned no screen sources');

  const wanted = String(display.id);
  let source = sources.find(s => String(s.display_id) === wanted);
  let matchedBy = 'display_id';

  if (!source) {
    source = sources.find(s => {
      const size = s.thumbnail.getSize();
      return size.width === native.width && size.height === native.height;
    });
    matchedBy = source ? 'size heuristic' : 'first source (fallback)';
    if (!source) source = sources[0];
  }

  const image = source.thumbnail;
  const size = image.getSize();

  log(`captured "${source.name}" via ${matchedBy} at ${size.width}x${size.height}`);

  return { buffer: image.toPNG(), size, sourceName: source.name, matchedBy };
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

let overlayWindow = null;

/**
 * A transparent, click-through, always-on-top window covering exactly one
 * display. This is the same mechanism the product's overlay uses, minus the
 * content protection — the spike must be screenshottable, because the only
 * honest way to check an arrow landed on a button is to look at a picture of it.
 */
function createOverlay(display) {
  const b = display.bounds;

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    // Created resizable, then locked below. Windows silently clamps a
    // non-resizable window to the work area, which cost us the bottom 48px —
    // the taskbar strip. "Open Premiere from the taskbar" is a legitimate first
    // step in a guided task, so the overlay has to be able to draw over it.
    resizable: true,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Re-assert the full display bounds after creation, then lock the size. The
  // constructor's bounds get clamped; setBounds does not.
  win.setBounds(b);
  win.setResizable(false);

  // Above fullscreen apps — Premiere and Unreal are the target use case and
  // both spend most of their time maximised.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Click-through: the arrow points at a real button, so the user has to be
  // able to actually click that button through the arrow.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'overlay.html'));
  return win;
}

function showArrow(payload) {
  if (!overlayWindow) return;
  overlayWindow.webContents.send('spike:arrow', payload);
}

/**
 * Re-capture the display with the arrow drawn on it.
 *
 * This is the actual evidence. "The coordinates computed correctly" is not the
 * claim being tested — the claim is "the arrow is on the button", and the only
 * way to settle that is to look at a picture of the screen with the arrow on it.
 *
 * Works because the spike's overlay is deliberately NOT content-protected,
 * unlike the product's (see STEALTH_MODE). It doubles as the artifact worth
 * keeping: a real screenshot of a real app with Handrail pointing at a control.
 */
async function captureResult(display, filename) {
  // Wait out the fade-in and one pulse cycle, so the ring is at full opacity
  // rather than caught mid-animation.
  await new Promise(r => setTimeout(r, 900));

  const shot = await captureDisplay(display);
  const out = path.join(OUT_DIR, filename);
  fs.writeFileSync(out, shot.buffer);
  log(`result screenshot written to ${out}`);
  return out;
}

// ---------------------------------------------------------------------------
// Dry-run fixtures
// ---------------------------------------------------------------------------

/**
 * Known boxes at known places, so a screenshot of the result can be checked by
 * eye against arithmetic. Corners catch sign and origin errors; the centre
 * catches scale errors; the thin strip catches aspect-ratio errors, which are
 * the ones a square test box would hide.
 */
const DRY_RUN_BOXES = [
  { label: 'top-left 10%', box_2d: [50, 50, 150, 150] },
  { label: 'centre', box_2d: [450, 450, 550, 550] },
  { label: 'bottom-right 10%', box_2d: [850, 850, 950, 950] },
  { label: 'wide thin strip', box_2d: [700, 100, 730, 900] },
  // Sits inside the Windows taskbar strip. Regression guard for the work-area
  // clamp — if the overlay is ever shortened again, this box vanishes.
  { label: 'bottom edge (taskbar)', box_2d: [975, 420, 998, 580] },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const displays = screen.getAllDisplays();
  log(`${displays.length} display(s):`);
  displays.forEach((d, i) => {
    log(
      `  [${i}] id=${d.id} bounds=${d.bounds.width}x${d.bounds.height} at ` +
      `(${d.bounds.x},${d.bounds.y}) scale=${d.scaleFactor} native=` +
      `${nativeCaptureSize(d).width}x${nativeCaptureSize(d).height}`
    );
  });

  const display = chooseDisplay();
  log(`target display: id=${display.id} scale=${display.scaleFactor}`);

  overlayWindow = createOverlay(display);
  await new Promise(resolve => overlayWindow.webContents.once('did-finish-load', resolve));

  if (OPTS.dryRun) {
    log('DRY RUN — no API call. Drawing fixed boxes to validate the coordinate chain.');

    const targets = DRY_RUN_BOXES.map(fixture => {
      const box = parseBox(fixture.box_2d);
      const rect = boxToScreenRect(box, display);
      log(
        `  ${fixture.label.padEnd(20)} norm[${fixture.box_2d.join(',')}] -> ` +
        `local ${rect.local.left.toFixed(0)},${rect.local.top.toFixed(0)} ` +
        `${rect.local.width.toFixed(0)}x${rect.local.height.toFixed(0)}`
      );
      return { label: fixture.label, rect: rect.local, confidence: 1 };
    });

    showArrow({ mode: 'dry-run', display: display.bounds, targets });
    await captureResult(display, 'dry-run.png');
    return;
  }

  if (!OPTS.target) {
    throw new Error('no target given. Try: npm run spike:arrow -- "the Save button"');
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is empty in .env. The key must be on the OPENROUTER_API_KEY ' +
      'line, not GEMINI_API_KEY. Run with --dry-run to test everything except the model.'
    );
  }

  // Give the overlay a moment to be composited, then hide it during capture —
  // otherwise a previous run's arrow ends up in the screenshot the model reads.
  overlayWindow.hide();
  const capture = await captureDisplay(display);
  overlayWindow.show();

  const shotPath = path.join(OUT_DIR, 'capture.png');
  fs.writeFileSync(shotPath, capture.buffer);
  log(`screenshot written to ${shotPath}`);

  const aspect = assertCaptureMatchesDisplay(capture.size, display.bounds);
  if (!aspect.ok) {
    log(`WARNING: ${aspect.reason}`);
    log('Coordinates below are suspect — the normalised mapping assumes a full-display capture.');
  }

  log(`asking model for: "${OPTS.target}"`);
  const result = await locateControl({
    apiKey,
    model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
    imageBuffer: capture.buffer,
    target: OPTS.target,
  });

  log(`model replied in ${result.elapsedMs}ms`);
  fs.writeFileSync(
    path.join(OUT_DIR, 'result.json'),
    JSON.stringify({ target: OPTS.target, display: display.bounds, result }, null, 2)
  );

  if (!result.ok) {
    log(`FAILED to parse model output: ${result.error}`);
    if (result.raw) log(`raw: ${result.raw.slice(0, 500)}`);
    return;
  }

  const value = result.value;
  log(`model said: ${JSON.stringify(value)}`);

  if (value.found === false) {
    log(`model reported not found: ${value.reason || '(no reason)'}`);
    showArrow({ mode: 'not-found', reason: value.reason || 'Control not found on screen', targets: [] });
    return;
  }

  const box = parseBox(value);
  if (!isBoxSane(box)) {
    log(`box failed sanity check: ${JSON.stringify(box)}`);
    log('Either the model ignored the 0-1000 convention or it returned garbage.');
    return;
  }

  const rect = boxToScreenRect(box, display);
  log(
    `box norm[${box.ymin},${box.xmin},${box.ymax},${box.xmax}] -> screen ` +
    `${rect.screen.centerX.toFixed(0)},${rect.screen.centerY.toFixed(0)} ` +
    `(${rect.local.width.toFixed(0)}x${rect.local.height.toFixed(0)} DIP)`
  );

  showArrow({
    mode: 'located',
    display: display.bounds,
    instruction: value.instruction || '',
    targets: [
      {
        label: value.label || OPTS.target,
        rect: rect.local,
        confidence: typeof value.confidence === 'number' ? value.confidence : null,
      },
    ],
  });

  await captureResult(display, 'located.png');
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (process.env.SPIKE_TRACE) console.error(err);
    app.quit();
    return;
  }

  globalShortcut.register('Escape', () => app.quit());
  log(`holding for ${OPTS.holdMs}ms — press Escape to quit early`);
  setTimeout(() => app.quit(), OPTS.holdMs);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
