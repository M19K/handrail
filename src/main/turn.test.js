/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * The turn state machine.
 *
 * This is the file the review called out as load-bearing and untested: step
 * transitions, the epoch guard that stops an arrow appearing after Handrail has
 * been put away, and which thread a turn is written to. All of it runs without
 * Electron — `turn.js` only reaches Electron through `capture.js`, which is
 * stubbed below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load;
Module._load = function stubElectron(request, ...rest) {
  if (request === 'electron') return { desktopCapturer: {}, screen: {} };
  return originalLoad.call(this, request, ...rest);
};
const { TurnController, friendly, firstSentence } = require('./turn');
Module._load = originalLoad;

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

/** A controller with everything stubbed and every side effect recorded. */
function harness(overrides = {}) {
  const events = [];
  const points = [];
  const threads = new Map();
  const appended = [];

  const store = {
    settings: { capture: true, pointing: true, stealth: true, watching: true },
    getSettings() { return this.settings; },
    listThreads() {
      return [...threads.values()]
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    getThread(id) { return threads.get(id) || null; },
    createThread() {
      const t = { id: `t${threads.size + 1}`, title: 'New thread', updatedAt: Date.now(), turns: [] };
      threads.set(t.id, t);
      return t;
    },
    appendTurn(id, turn) {
      appended.push({ id, turn });
      const t = threads.get(id);
      if (t) t.turns.push(turn);
    },
  };

  const llm = {
    respond: async () => ({ kind: 'answer', markdown: 'ok' }),
    locate: async () => ({ found: true, box: [400, 400, 500, 450], label: 'Save' }),
    checkStep: async () => ({ status: 'pending' }),
    ...overrides.llm,
  };

  const turns = new TurnController({
    llm,
    store,
    getOverlay: () => null,
    emit: (e) => events.push(e),
    point: (p) => points.push(p),
    excludeFromCapture: () => () => {},
  });

  return { turns, events, points, store, threads, appended };
}

/** A task in mid-flight, without going through the model. */
function withTask(turns, steps) {
  turns.task = {
    taskId: 'task_1',
    title: 'Do the thing',
    display: DISPLAY,
    activeIndex: 0,
    failures: 0,
    steps: steps.map((s, i) => ({ ...s, status: i === 0 ? 'active' : 'todo' })),
  };
  return turns.task;
}

// --- C5: nothing may be drawn after the user has put Handrail away ----------

test('an arrow found after reset() is not drawn', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });

  const h = harness({
    llm: { locate: async () => { await gate; return { found: true, box: [400, 400, 500, 450] }; } },
  });

  const pointing = h.turns._pointAtTarget({
    display: DISPLAY,
    screenshot: Buffer.from('png'),
    target: 'Save button',
    instruction: 'Click Save',
  });

  // The user hits the panic hotkey while locate() is still in flight.
  h.turns.reset();
  release();
  await pointing;

  assert.ok(!h.points.some((p) => p), 'no arrow payload may be drawn after reset');
  assert.ok(
    !h.events.some((e) => e.type === 'point' && e.rect),
    'and the overlay must not be told one was',
  );
});

test('an arrow found after a NEW ask is not drawn either', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    llm: { locate: async () => { await gate; return { found: true, box: [400, 400, 500, 450] }; } },
  });

  const pointing = h.turns._pointAtTarget({
    display: DISPLAY, screenshot: Buffer.from('png'), target: 'Save', instruction: 'Click Save',
  });
  h.turns._abortRequest();     // what ask() does first
  release();
  await pointing;

  assert.ok(!h.points.some((p) => p), 'a superseded turn must not draw');
});

test('an arrow found with nothing in the way IS drawn', async () => {
  // The guard must not be so eager that it breaks the normal case.
  const h = harness();
  await h.turns._pointAtTarget({
    display: DISPLAY, screenshot: Buffer.from('png'), target: 'Save', instruction: 'Click Save',
  });
  assert.ok(h.points.some((p) => p && p.layout), 'the arrow should be drawn');
  assert.ok(h.events.some((e) => e.type === 'point' && e.rect), 'and reported');
});

test('pointing switched off mid-locate suppresses the arrow', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    llm: { locate: async () => { await gate; return { found: true, box: [400, 400, 500, 450] }; } },
  });

  const pointing = h.turns._pointAtTarget({
    display: DISPLAY, screenshot: Buffer.from('png'), target: 'Save', instruction: 'Click Save',
  });
  h.store.settings.pointing = false;
  release();
  await pointing;

  assert.ok(!h.points.some((p) => p), 'the setting has to win even mid-flight');
});

// --- R3: the badge clears whenever the arrow does ---------------------------

test('a failed locate tells the overlay the arrow is gone', async () => {
  const h = harness({ llm: { locate: async () => ({ found: false }) } });
  await h.turns._pointAtTarget({
    display: DISPLAY, screenshot: Buffer.from('png'), target: 'Save', instruction: 'x',
  });
  assert.deepEqual(h.events.filter((e) => e.type === 'point'), [{ type: 'point', rect: null }]);
});

test('an out-of-range box is refused, and reported as cleared', async () => {
  // Raw pixels instead of the 0-1000 convention: the arrow would land several
  // screens to the right rather than erroring.
  const h = harness({ llm: { locate: async () => ({ found: true, box: [1900, 1000, 1910, 1020] }) } });
  await h.turns._pointAtTarget({
    display: DISPLAY, screenshot: Buffer.from('png'), target: 'Save', instruction: 'x',
  });
  assert.ok(!h.points.some((p) => p));
  assert.ok(h.events.some((e) => e.type === 'point' && e.rect === null));
});

// --- C6: turns are written to the thread the user has open ------------------

test('a follow-up goes to the thread the renderer has open, not the newest', async () => {
  const h = harness();
  const old = h.store.createThread();
  const recent = h.store.createThread();
  old.updatedAt = 1;
  recent.updatedAt = 2;

  h.turns.threadId = old.id;
  h.turns._record('what next?', { kind: 'answer', markdown: 'this' });

  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].id, old.id, 'must append to the OPEN thread');
});

test('with nothing open it falls back to the most recently updated thread', async () => {
  const h = harness();
  const older = h.store.createThread();
  const newer = h.store.createThread();
  older.updatedAt = 1;
  newer.updatedAt = 2;

  h.turns._record('hello', { kind: 'answer', markdown: 'hi' });
  assert.equal(h.appended[0].id, newer.id);
});

test('a thread that has been deleted falls back instead of losing the turn', async () => {
  const h = harness();
  const alive = h.store.createThread();
  alive.updatedAt = 5;
  h.turns.threadId = 'gone';

  h.turns._record('hello', { kind: 'answer', markdown: 'hi' });
  assert.equal(h.appended[0].id, alive.id);
  assert.equal(h.turns.threadId, alive.id, 'and re-pins to where it actually landed');
});

test('ask() takes the open thread from the renderer', async () => {
  const h = harness();
  const a = h.store.createThread();
  await h.turns.ask({ text: 'hi', capture: false, turnId: 'x1', threadId: a.id });
  assert.equal(h.turns.threadId, a.id);
});

test('reset() forgets the open thread', () => {
  const h = harness();
  h.turns.threadId = 't9';
  h.turns.reset();
  assert.equal(h.turns.threadId, null);
});

// --- step transitions -------------------------------------------------------

test('completing a step looks forward, not back over a wrong one', async () => {
  const h = harness();
  h.store.settings.pointing = false;
  const task = withTask(h.turns, [{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  task.steps[0].status = 'wrong';
  task.steps[1].status = 'done';
  task.activeIndex = 2;

  await h.turns.completeStep('task_1', 2);

  // Nothing ahead of 2 is unfinished, so it may fall back to step 0 — what it
  // must NOT do is pick step 0 while something after 2 is still to do.
  const activated = h.events.filter((e) => e.type === 'step' && e.status === 'active');
  assert.equal(activated.length, 1);
  assert.equal(activated[0].index, 0);
});

test('a later unfinished step wins over an earlier wrong one', async () => {
  const h = harness();
  h.store.settings.pointing = false;
  const task = withTask(h.turns, [{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  task.steps[0].status = 'wrong';
  task.activeIndex = 1;

  await h.turns.completeStep('task_1', 1);

  const activated = h.events.filter((e) => e.type === 'step' && e.status === 'active');
  assert.equal(activated[0].index, 2, 'ticking step 2 must not drag the user back to step 1');
});

test('finishing the last step stops watching and clears the arrow', async () => {
  const h = harness();
  const task = withTask(h.turns, [{ text: 'only' }]);
  task.steps[0].status = 'active';

  await h.turns.completeStep('task_1', 0);

  assert.equal(h.turns.watch, null);
  assert.ok(h.events.some((e) => e.type === 'point' && e.rect === null));
});

test('a step event for a task that is no longer running is ignored', async () => {
  const h = harness();
  withTask(h.turns, [{ text: 'one' }]);
  await h.turns.completeStep('task_stale', 0);
  assert.equal(h.events.length, 0);
});

test('three unreadable verdicts stop the watch and say so', async () => {
  const h = harness({ llm: { checkStep: async () => null } });
  const task = withTask(h.turns, [{ text: 'one' }]);

  await h.turns._checkActiveStep(Buffer.from('png'));
  await h.turns._checkActiveStep(Buffer.from('png'));
  assert.ok(!h.events.some((e) => e.status === 'unwatched'), 'not before the third');
  await h.turns._checkActiveStep(Buffer.from('png'));

  assert.ok(h.events.some((e) => e.status === 'unwatched'), 'the user has to be told');
  assert.equal(task.failures, 3);
});

test('a readable verdict resets the failure counter', async () => {
  let verdict = null;
  const h = harness({ llm: { checkStep: async () => verdict } });
  const task = withTask(h.turns, [{ text: 'one' }, { text: 'two' }]);

  await h.turns._checkActiveStep(Buffer.from('png'));
  await h.turns._checkActiveStep(Buffer.from('png'));
  verdict = { status: 'pending' };
  await h.turns._checkActiveStep(Buffer.from('png'));

  assert.equal(task.failures, 0);
});

test('an empty plan does not poison the task', async () => {
  const h = harness();
  const turn = { id: 'x', cancelled: false };
  await h.turns._startTask(turn, { title: 'Nothing to do', steps: [] }, DISPLAY, 'p', null);

  assert.equal(h.turns.task, null, 'no task object with no steps in it');
  assert.ok(h.events.some((e) => e.type === 'answer'));
  assert.ok(h.events.some((e) => e.type === 'done'));
});

test('a started task carries its title, which the model is quoted back', async () => {
  const h = harness();
  h.store.settings.pointing = false;
  h.store.settings.capture = false;
  const turn = { id: 'x', cancelled: false };
  await h.turns._startTask(turn, { title: 'Install it', steps: [{ text: 'a' }, { text: 'b' }] }, DISPLAY, 'p', null);

  assert.equal(h.turns.task.title, 'Install it');
  assert.equal(h.turns.task.steps[0].status, 'active');
});

// --- error wording ----------------------------------------------------------

test('friendly() does not read a token count as a server error', () => {
  assert.equal(friendly(new Error('maximum context is 5000 tokens')), 'maximum context is 5000 tokens');
});

test('friendly() does not read a request id as a rejected key', () => {
  assert.equal(friendly(new Error('request 401829 failed')), 'request 401829 failed');
});

test('friendly() still catches the real codes', () => {
  assert.match(friendly(new Error('HTTP 401 Unauthorized')), /rejected/);
  assert.match(friendly(new Error('HTTP 503')), /provider is having problems/);
  assert.match(friendly(new Error('429 Too Many Requests')), /rate-limiting/);
});

test('friendly() prefers err.status over the message', () => {
  const err = new Error('something opaque');
  err.status = 401;
  assert.match(friendly(err), /rejected/);
});

test('friendly() handles a missing key and an empty error', () => {
  const err = new Error('nope');
  err.code = 'NO_KEY';
  assert.match(friendly(err), /No API key/);
  assert.equal(friendly(null), 'Something went wrong.');
});

// --- the arrow's label ------------------------------------------------------

test('firstSentence does not stop at an abbreviation', () => {
  assert.equal(
    firstSentence('Use the crop tool, e.g. the one in the left toolbar.'),
    'Use the crop tool, e.g. the one in the left toolbar.',
  );
});

test('firstSentence still stops at a real sentence end', () => {
  assert.equal(firstSentence('Click Save. Then close the dialog.'), 'Click Save.');
});

test('firstSentence strips markdown and collapses whitespace', () => {
  assert.equal(firstSentence('Press **Ctrl+K**, then type `open`.'), 'Press Ctrl+K, then type open.');
});

test('firstSentence truncates rather than returning an essay', () => {
  assert.ok(firstSentence('word '.repeat(80)).length <= 140);
});
