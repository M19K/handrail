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
