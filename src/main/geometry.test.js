/**
 * Arrow spike — coordinate math tests.
 *
 * Runs on Node's built-in test runner: `node --test spike/arrow/`. No test
 * framework, no dependency, no config. The repo has no test harness yet and the
 * spike is not the place to choose one.
 *
 * These need no screen, no Electron and no API key, which is the point — the
 * coordinate chain is the part most likely to be quietly wrong, and it can be
 * proven correct before a single token is spent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBox,
  isBoxSane,
  assertCaptureMatchesDisplay,
  boxToScreenRect,
  displayForWindowBounds,
  nativeCaptureSize,
} = require('./geometry');

// Display fixtures modelled on real-world setups, including the awkward ones.
const PRIMARY_1X = {
  id: 1, scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
};

// 4K panel at 150% — the case where DIP and physical pixels diverge.
const SECOND_1_5X = {
  id: 2, scaleFactor: 1.5,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  size: { width: 2560, height: 1440 },
};

// Negative origin: a monitor placed to the LEFT of primary. Sign errors in the
// offset maths only show up here.
const LEFT_OF_PRIMARY = {
  id: 3, scaleFactor: 1,
  bounds: { x: -1280, y: -100, width: 1280, height: 1024 },
  size: { width: 1280, height: 1024 },
};

test('parseBox reads the requested [ymin, xmin, ymax, xmax] form', () => {
  const box = parseBox({ box_2d: [100, 200, 300, 400] });
  assert.deepEqual(box, { ymin: 100, xmin: 200, ymax: 300, xmax: 400 });
});

test('parseBox accepts a bare array', () => {
  assert.deepEqual(parseBox([10, 20, 30, 40]), { ymin: 10, xmin: 20, ymax: 30, xmax: 40 });
});

test('parseBox repairs an inverted box rather than rejecting it', () => {
  // Models occasionally emit max before min. Silently swapping is right: the
  // extent is unambiguous and the alternative is discarding a usable answer.
  const box = parseBox([300, 400, 100, 200]);
  assert.deepEqual(box, { ymin: 100, xmin: 200, ymax: 300, xmax: 400 });
});

test('parseBox accepts the {x, y, width, height} variant', () => {
  const box = parseBox({ x: 200, y: 100, width: 200, height: 200 });
  assert.deepEqual(box, { ymin: 100, xmin: 200, ymax: 300, xmax: 400 });
});

test('parseBox turns a bare point into a zero-extent box', () => {
  assert.deepEqual(parseBox({ x: 500, y: 500 }), { ymin: 500, xmin: 500, ymax: 500, xmax: 500 });
});

test('parseBox returns null for unreadable input', () => {
  assert.equal(parseBox(null), null);
  assert.equal(parseBox({ nonsense: true }), null);
  assert.equal(parseBox([1, 2, 3]), null);
});

test('isBoxSane rejects coordinates outside the 0-1000 space', () => {
  // This is the guard against a model that ignored the convention and returned
  // raw pixels. A 1920-wide pixel box would otherwise map to five screens right.
  assert.equal(isBoxSane({ ymin: 0, xmin: 0, ymax: 1080, xmax: 1920 }), false);
  assert.equal(isBoxSane({ ymin: -5, xmin: 0, ymax: 100, xmax: 100 }), false);
  assert.equal(isBoxSane({ ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 }), true);
});

test('boxToScreenRect maps the centre of the space to the centre of the display', () => {
  const { screen, local } = boxToScreenRect(parseBox([500, 500, 500, 500]), PRIMARY_1X);
  assert.equal(screen.centerX, 960);
  assert.equal(screen.centerY, 540);
  assert.equal(local.centerX, 960);
  assert.equal(local.centerY, 540);
});

test('boxToScreenRect ignores scaleFactor entirely', () => {
  // The same normalised box on a 1x and a 1.5x display must land at the same
  // FRACTION of each display. If scaleFactor ever leaks into the maths, this
  // is the test that catches it.
  const a = boxToScreenRect(parseBox([250, 250, 750, 750]), PRIMARY_1X);
  const b = boxToScreenRect(parseBox([250, 250, 750, 750]), SECOND_1_5X);

  assert.equal(a.local.centerX / PRIMARY_1X.bounds.width, 0.5);
  assert.equal(b.local.centerX / SECOND_1_5X.bounds.width, 0.5);
  assert.equal(a.local.width / PRIMARY_1X.bounds.width, 0.5);
  assert.equal(b.local.width / SECOND_1_5X.bounds.width, 0.5);
});

test('boxToScreenRect offsets screen coordinates by the display origin', () => {
  const { screen, local } = boxToScreenRect(parseBox([0, 0, 100, 100]), SECOND_1_5X);
  assert.equal(local.left, 0);
  assert.equal(screen.left, 1920);          // display origin
  assert.equal(screen.centerX, 1920 + 128); // 10% of 2560 / 2
});

test('boxToScreenRect handles a display at negative coordinates', () => {
  const { screen, local } = boxToScreenRect(parseBox([500, 500, 500, 500]), LEFT_OF_PRIMARY);
  assert.equal(local.centerX, 640);
  assert.equal(screen.centerX, -1280 + 640);
  assert.equal(screen.centerY, -100 + 512);
});

test('boxToScreenRect preserves a non-square box shape', () => {
  // A wide thin strip must stay wide and thin. Uniform scaling would hide an
  // aspect bug; independent x/y scaling is what makes this pass.
  const { local } = boxToScreenRect(parseBox([700, 100, 730, 900]), PRIMARY_1X);
  assert.equal(local.width, 0.8 * 1920);
  // Sub-pixel tolerance: 30/1000 * 1080 is not exactly representable in binary
  // floating point. Arrow placement cares about pixels, not ulps.
  assert.ok(Math.abs(local.height - 32.4) < 1e-6, `height was ${local.height}`);
});

test('assertCaptureMatchesDisplay passes for a native-resolution capture', () => {
  const r = assertCaptureMatchesDisplay({ width: 3840, height: 2160 }, SECOND_1_5X.bounds);
  assert.equal(r.ok, true);
});

test('assertCaptureMatchesDisplay flags a capture from the wrong monitor', () => {
  // 1280x1024 is 5:4; the display is 16:9. This is exactly what the size
  // heuristic in capture.service.js gets wrong on a mixed multi-monitor rig.
  const r = assertCaptureMatchesDisplay({ width: 1280, height: 1024 }, PRIMARY_1X.bounds);
  assert.equal(r.ok, false);
  assert.match(r.reason, /aspect/);
});

test('displayForWindowBounds picks the display containing the window centre', () => {
  const displays = [PRIMARY_1X, SECOND_1_5X, LEFT_OF_PRIMARY];

  // Window mostly on primary but overlapping the second display's edge.
  const win = { x: 1800, y: 400, width: 200, height: 100 };
  assert.equal(displayForWindowBounds(win, displays).id, PRIMARY_1X.id);

  // Nudge it right so its centre crosses over.
  const win2 = { x: 1900, y: 400, width: 200, height: 100 };
  assert.equal(displayForWindowBounds(win2, displays).id, SECOND_1_5X.id);
});

test('displayForWindowBounds falls back to nearest when the centre is in dead space', () => {
  // Monitors of different heights leave gaps in the virtual desktop. A window
  // dragged into one must still resolve to a display rather than null.
  const displays = [PRIMARY_1X, LEFT_OF_PRIMARY];
  const win = { x: -1300, y: 1500, width: 100, height: 100 };
  const picked = displayForWindowBounds(win, displays);
  assert.equal(picked.id, LEFT_OF_PRIMARY.id);
});

test('nativeCaptureSize multiplies DIP size back up to physical pixels', () => {
  assert.deepEqual(nativeCaptureSize(PRIMARY_1X), { width: 1920, height: 1080 });
  assert.deepEqual(nativeCaptureSize(SECOND_1_5X), { width: 3840, height: 2160 });
});

// ---------------------------------------------------------------------------
// arrowLayout — the fix for the arrow making the whole machine feel slow.
//
// The window used to cover the entire display, which meant the compositor
// blended a full-screen always-on-top layer continuously. These tests exist to
// stop that regressing: if `region` ever creeps back toward display size, the
// lag comes back and nothing else would catch it.
// ---------------------------------------------------------------------------

const { arrowLayout, chooseApproach } = require('./geometry');

const SCREEN = { width: 1920, height: 1080 };

test('arrowLayout covers a small fraction of the display', () => {
  const target = { left: 900, top: 500, width: 40, height: 24 };
  const { region } = arrowLayout(target, SCREEN);

  const coverage = (region.width * region.height) / (SCREEN.width * SCREEN.height);
  assert.ok(coverage < 0.12, `region covers ${(coverage * 100).toFixed(1)}% of the display`);
});

test('arrowLayout stays inside the display for a target in each corner', () => {
  const corners = [
    { left: 4, top: 4, width: 30, height: 24 },
    { left: SCREEN.width - 34, top: 4, width: 30, height: 24 },
    { left: 4, top: SCREEN.height - 28, width: 30, height: 24 },
    { left: SCREEN.width - 34, top: SCREEN.height - 28, width: 30, height: 24 },
  ];

  for (const target of corners) {
    const { region } = arrowLayout(target, SCREEN);
    assert.ok(region.x >= 0 && region.y >= 0, `region origin negative: ${JSON.stringify(region)}`);
    assert.ok(region.x + region.width <= SCREEN.width, 'region runs off the right edge');
    assert.ok(region.y + region.height <= SCREEN.height, 'region runs off the bottom edge');
    assert.ok(region.width > 0 && region.height > 0, 'region collapsed');
  }
});

test('arrowLayout returns coordinates relative to its own region', () => {
  // The renderer draws in window space and knows nothing about displays, so
  // every point must land inside the region it was given.
  const target = { left: 1400, top: 700, width: 60, height: 30 };
  const { region, tip, tail, ctrl } = arrowLayout(target, SCREEN);

  for (const [name, p] of [['tip', tip], ['tail', tail], ['ctrl', ctrl]]) {
    assert.ok(p[0] >= 0 && p[0] <= region.width, `${name} x=${p[0]} outside region width ${region.width}`);
    assert.ok(p[1] >= 0 && p[1] <= region.height, `${name} y=${p[1]} outside region height ${region.height}`);
  }
});

test('arrowLayout tip stops short of the control and never covers it', () => {
  // A tip resting on the target reads as covering the thing the user has just
  // been told to click.
  const target = { left: 1200, top: 500, width: 40, height: 24 };
  const { region, tip, approach } = arrowLayout(target, SCREEN);

  const tipScreenX = tip[0] + region.x;
  const tipScreenY = tip[1] + region.y;
  const insideX = tipScreenX > target.left && tipScreenX < target.left + target.width;
  const insideY = tipScreenY > target.top && tipScreenY < target.top + target.height;

  assert.ok(!(insideX && insideY), `tip landed inside the target (approach: ${approach})`);
});

test('chooseApproach picks the side with the most room', () => {
  assert.equal(chooseApproach({ left: 1700, top: 500, width: 40, height: 24 }, SCREEN), 'left');
  assert.equal(chooseApproach({ left: 40, top: 500, width: 40, height: 24 }, SCREEN), 'right');
  assert.equal(chooseApproach({ left: 900, top: 40, width: 40, height: 24 }, SCREEN), 'bottom');
  assert.equal(chooseApproach({ left: 900, top: 1000, width: 40, height: 24 }, SCREEN), 'top');
});

test('arrowLayout handles a scaled display the same as an unscaled one', () => {
  // Everything here is DIP, so a 2x panel presenting as 1440x900 must produce
  // the same shape as any other 1440x900 display. scaleFactor never enters.
  const small = { width: 1440, height: 900 };
  const target = { left: 700, top: 400, width: 40, height: 24 };
  const { region } = arrowLayout(target, small);
  assert.ok(region.width < small.width * 0.6, 'region too wide for a smaller display');
  assert.ok(region.height < small.height * 0.6, 'region too tall for a smaller display');
});
