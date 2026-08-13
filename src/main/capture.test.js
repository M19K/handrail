/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Which screen did we actually capture?
 *
 * `selectSource` was extracted from `captureDisplay` so this could be tested
 * without Electron. It is the code that decides which monitor the model is
 * shown, and it had no test at all — while the bug it exists to prevent
 * (capturing the wrong screen and reporting nothing wrong) is silent by nature.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load;
Module._load = function stubElectron(request, ...rest) {
  if (request === 'electron') return { desktopCapturer: {}, screen: {} };
  return originalLoad.call(this, request, ...rest);
};
const { selectSource, captureMatchesDisplay } = require('./capture');
Module._load = originalLoad;

const source = (id, width, height) => ({
  display_id: id,
  thumbnail: { getSize: () => ({ width, height }) },
});

const display = (id, width, height) => ({ id, bounds: { x: 0, y: 0, width, height } });

test('matches on display_id when the compositor supplies one', () => {
  const sources = [source('11', 1920, 1080), source('22', 2880, 1800)];
  const got = selectSource(sources, display(22, 1440, 900), { width: 2880, height: 1800 });
  assert.equal(got.matched, 'display_id');
  assert.equal(got.source.display_id, '22');
});

test('display_id wins even when another source is the requested size', () => {
  // The size heuristic would pick the first here. It must not get the chance.
  const sources = [source('11', 2880, 1800), source('22', 640, 400)];
  const got = selectSource(sources, display(22, 1440, 900), { width: 2880, height: 1800 });
  assert.equal(got.matched, 'display_id');
  assert.equal(got.source.display_id, '22');
});

test('falls back to size, and says it guessed', () => {
  const sources = [source('', 1920, 1080), source('', 2880, 1800)];
  const got = selectSource(sources, display(22, 1440, 900), { width: 2880, height: 1800 });
  assert.equal(got.matched, 'size');
  assert.deepEqual(got.source.thumbnail.getSize(), { width: 2880, height: 1800 });
});

test('reports fallback when it matched nothing at all', () => {
  // This is the case that used to be invisible: two same-aspect monitors, no
  // display_id, and the watch loop happily judging the wrong screen.
  const sources = [source('', 1920, 1080), source('', 1600, 900)];
  const got = selectSource(sources, display(22, 1440, 900), { width: 2880, height: 1800 });
  assert.equal(got.matched, 'fallback');
  assert.equal(got.source, sources[0]);
});

test('captureMatchesDisplay accepts a downscaled check frame', () => {
  // The cheap watch capture is scaled to a 1024px long edge. Aspect ratio, not
  // size, is what has to survive.
  assert.equal(captureMatchesDisplay({ width: 1024, height: 640 }, display(1, 1440, 900)), true);
  assert.equal(captureMatchesDisplay({ width: 1024, height: 576 }, display(1, 1920, 1080)), true);
});

test('captureMatchesDisplay rejects a different screen and rejects nothing', () => {
  assert.equal(captureMatchesDisplay({ width: 1024, height: 576 }, display(1, 1440, 900)), false);
  assert.equal(captureMatchesDisplay(null, display(1, 1440, 900)), false);
  assert.equal(captureMatchesDisplay({ width: 0, height: 0 }, display(1, 1440, 900)), false);
});

/**
 * Self-exclusion by masking, which replaced the content-protection toggle.
 *
 * The toggle worked, but it is also what removes a window from a SCREEN SHARE:
 * on a Google Meet call with stealth deliberately off, the overlay blinked out
 * and back on every single question — flicker for the viewer, static locally.
 * These pin the geometry, because a mask in the wrong place either leaves
 * Handrail in its own screenshot or blacks out the thing the user asked about.
 */

const { maskRegions, rectInImage } = require('./capture');

const DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

test('a window maps into a natively-sized capture 1:1', () => {
  const r = rectInImage({ x: 100, y: 50, width: 400, height: 60 }, DISPLAY,
    { width: 1920, height: 1080 });
  assert.deepEqual(r, { x: 100, y: 50, width: 400, height: 60 });
});

test('a window maps into a DOWNSCALED capture proportionally', () => {
  // The answer tier captures at 1600 wide, so the mask has to shrink with it.
  const r = rectInImage({ x: 960, y: 540, width: 480, height: 108 }, DISPLAY,
    { width: 1600, height: 900 });
  assert.deepEqual(r, { x: 800, y: 450, width: 400, height: 90 });
});

test('a window on a second display, at an offset, is placed relative to it', () => {
  const second = { bounds: { x: 1920, y: 0, width: 1280, height: 720 } };
  const r = rectInImage({ x: 1920 + 40, y: 10, width: 200, height: 40 }, second,
    { width: 1280, height: 720 });
  assert.equal(r.x, 40);
  assert.equal(r.y, 10);
});

test('a window on another display does not mask this one', () => {
  const r = rectInImage({ x: -900, y: 10, width: 400, height: 40 }, DISPLAY,
    { width: 1920, height: 1080 });
  assert.equal(r, null);
});

test('masking blanks exactly the rectangle and nothing else', () => {
  const size = { width: 4, height: 3 };
  const bitmap = Buffer.alloc(size.width * size.height * 4, 0xff);

  maskRegions(bitmap, size, [{ x: 1, y: 1, width: 2, height: 1 }]);

  const px = (x, y) => bitmap[(y * size.width + x) * 4];
  assert.equal(px(1, 1), 0, 'inside the rect is blanked');
  assert.equal(px(2, 1), 0, 'inside the rect is blanked');
  assert.equal(px(0, 1), 0xff, 'left of the rect is untouched');
  assert.equal(px(3, 1), 0xff, 'right of the rect is untouched');
  assert.equal(px(1, 0), 0xff, 'the row above is untouched');
  assert.equal(px(1, 2), 0xff, 'the row below is untouched');
});

test('a rect hanging off the edge is clipped, not wrapped onto the next row', () => {
  const size = { width: 4, height: 2 };
  const bitmap = Buffer.alloc(size.width * size.height * 4, 0xff);

  maskRegions(bitmap, size, [{ x: 3, y: 0, width: 99, height: 1 }]);

  const px = (x, y) => bitmap[(y * size.width + x) * 4];
  assert.equal(px(3, 0), 0, 'the visible part is blanked');
  assert.equal(px(0, 1), 0xff, 'the next row is NOT clobbered by an overrun');
});

test('no rects leaves the bitmap exactly as it was', () => {
  const bitmap = Buffer.alloc(16, 0xab);
  const copy = Buffer.from(bitmap);
  maskRegions(bitmap, { width: 2, height: 2 }, []);
  assert.deepEqual(bitmap, copy);
});
