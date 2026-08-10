/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * `respond()`, actually executed.
 *
 * The review named this as the one load-bearing function in the product with no
 * test at all, and it stayed open through /review and /qa: the provider client
 * was constructed inside `_client()`, so there was no seam to test through
 * without a network call and a funded key. `Llm` now takes an optional client
 * factory, and that is the only reason it does.
 *
 * What is checked here is the shape of the request going out and the shape of
 * the result coming back — the two things every other part of the product
 * depends on and nothing verified.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Llm } = require('./llm');

/** An Llm whose provider returns `text` and records what it was asked. */
function stubbed(text) {
  const calls = [];
  const llm = new Llm(
    () => 'sk-or-v1-test',
    () => 'test/model',
    () => ({
      models: {
        generateContent: async (req) => { calls.push(req); return { text }; },
      },
    }),
  );
  return { llm, calls };
}

const PNG = Buffer.from('fake png bytes');
const textOf = (req) => req.contents[0].parts.map((p) => p.text || '').join('\n');

// --- the request going out --------------------------------------------------

test('respond sends the screenshot as inline image data', async () => {
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"hi"}');
  await llm.respond({ prompt: 'what is this?', screenshot: PNG });

  const parts = calls[0].contents[0].parts;
  const image = parts.find((p) => p.inlineData);
  assert.ok(image, 'the screenshot is the whole premise; it must be in the request');
  assert.equal(image.inlineData.mimeType, 'image/png');
  assert.equal(image.inlineData.data, PNG.toString('base64'));

  // Picture first, question last. The image is context for the question.
  assert.ok(parts[0].inlineData);
  assert.equal(parts[parts.length - 1].text, 'what is this?');
});

test('respond sends no image part when capture is off', async () => {
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"hi"}');
  await llm.respond({ prompt: 'no screen', screenshot: null });
  assert.equal(calls[0].contents[0].parts.some((p) => p.inlineData), false);
});

test('respond puts the real conversation in the prompt, not a list of titles', async () => {
  // History used to be sent as `t.summary`, which for a checklist was only its
  // title — so the model saw repeated headings with no replies in them and had
  // nothing to be conversational about.
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"ok"}');
  await llm.respond({
    prompt: 'now what?',
    history: [
      { prompt: 'how do I export?', kind: 'task', title: 'Export a video', steps: [{ text: 'Open File' }, { text: 'Click Export' }] },
      { prompt: 'where is that?', kind: 'answer', markdown: 'Top left, under the File menu.' },
    ],
  });

  const text = textOf(calls[0]);
  assert.match(text, /how do I export\?/);
  assert.match(text, /Open File/, 'the steps of a past checklist must survive into history');
  assert.match(text, /Top left, under the File menu\./, 'past replies must be sent in full');
});

test('respond caps history rather than growing the prompt forever', async () => {
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"ok"}');
  const history = Array.from({ length: 20 }, (_, i) => ({ prompt: `q${i}`, kind: 'answer', markdown: `a${i}` }));
  await llm.respond({ prompt: 'latest', history });

  const text = textOf(calls[0]);
  assert.match(text, /q19/, 'the most recent turns must be there');
  assert.equal(/\bq0\b/.test(text), false, 'the oldest must be dropped; long threads are what max out a context window');
});

test('respond tells the model a checklist is already running', async () => {
  // Without this, "now what?" produced a second copy of the same checklist.
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"ok"}');
  await llm.respond({
    prompt: 'now what?',
    activeTask: {
      title: 'Add a cross dissolve',
      activeIndex: 1,
      steps: [
        { text: 'Open Effects', status: 'done' },
        { text: 'Pick the Razor tool', status: 'active' },
        { text: 'Drag it onto the join', status: 'todo' },
      ],
    },
  });

  const text = textOf(calls[0]);
  assert.match(text, /ALREADY RUNNING/);
  assert.match(text, /Add a cross dissolve/, 'the title is quoted back; it read as undefined for a whole release');
  assert.match(text, /CURRENT/, 'the model must be told which step they are on');
  assert.match(text, /step 2/, 'and told it in the numbering the user sees, not zero-based');
});

test('respond says nothing about a checklist when there is none', async () => {
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"ok"}');
  await llm.respond({ prompt: 'hello' });
  assert.equal(/ALREADY RUNNING/.test(textOf(calls[0])), false);
});

test('respond threads the abort signal all the way to the request', async () => {
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"ok"}');
  const controller = new AbortController();
  await llm.respond({ prompt: 'q', signal: controller.signal });
  assert.equal(calls[0].signal, controller.signal, 'without this, Escape leaves the call running and billed');
});

test('respond refuses to call the provider with no key', async () => {
  const llm = new Llm(() => null, () => 'test/model', () => { throw new Error('should never be built'); });
  await assert.rejects(() => llm.respond({ prompt: 'q' }), (err) => err.code === 'NO_KEY');
});

// --- the result coming back -------------------------------------------------

test('respond returns a task for a genuine multi-step plan', async () => {
  const { llm } = stubbed(JSON.stringify({
    kind: 'task',
    title: 'Install the thing',
    steps: [
      { text: 'Download it', hint: 'from the site', doneWhen: 'the file is there', target: 'Download button' },
      { text: 'Run the installer' },
      { text: '   ' },
    ],
  }));
  const out = await llm.respond({ prompt: 'how do I install it?' });

  assert.equal(out.kind, 'task');
  assert.equal(out.title, 'Install the thing');
  assert.equal(out.steps.length, 2, 'blank steps are dropped');
  assert.equal(out.steps[0].doneWhen, 'the file is there');
  assert.equal(out.steps[0].target, 'Download button');
  assert.equal(out.steps[1].hint, '', 'a missing hint is an empty string, never undefined');
});

test('respond caps a runaway plan at twelve steps', async () => {
  const { llm } = stubbed(JSON.stringify({
    kind: 'task',
    title: 'Too much',
    steps: Array.from({ length: 30 }, (_, i) => ({ text: `step ${i}` })),
  }));
  const out = await llm.respond({ prompt: 'do everything' });
  assert.equal(out.steps.length, 12);
});

test('respond turns a one-step plan into prose, not a checklist and not JSON', async () => {
  const { llm } = stubbed('{"kind":"task","title":"Turn on dark mode","steps":[{"text":"Click Appearance"}]}');
  const out = await llm.respond({ prompt: 'dark mode?' });
  assert.equal(out.kind, 'answer');
  assert.equal(out.markdown, 'Click Appearance');
});

test('a one-step plan keeps its arrow', async () => {
  /**
   * The bug this pins was silent from both ends.
   *
   * A one-step plan is turned into prose and returned as an answer, and the
   * answer branch only read the TOP-LEVEL `target` — which a task-shaped reply
   * does not have, because its target sits inside the step. So the model
   * correctly said "click the Razor tool", the user was told to click it, and
   * no arrow was ever drawn. `turn.js` skipped `_pointAtTarget` because the
   * target was empty, and nothing logged because nothing failed.
   *
   * Drawing the arrow is the one thing this product does that nothing else
   * does, so the quiet path deserves a test more than the loud one.
   */
  const { llm } = stubbed(JSON.stringify({
    kind: 'task',
    title: 'Split the clip',
    steps: [{ text: 'Click the Razor tool', target: 'Razor tool in the left toolbar' }],
  }));
  const out = await llm.respond({ prompt: 'how do I split a clip?' });
  assert.equal(out.kind, 'answer');
  assert.equal(out.markdown, 'Click the Razor tool');
  assert.equal(out.target, 'Razor tool in the left toolbar');
});

test('a plan whose first step has no target still points at the first one that does', async () => {
  // "Wait for it to finish" is a legitimate step with nothing to point at. The
  // arrow belongs on the first step that names a control, not nowhere.
  const { llm } = stubbed(JSON.stringify({
    kind: 'task',
    title: 'Install it',
    steps: [
      { text: 'Wait for the installer to finish', target: '' },
      { text: 'Click Continue', target: 'Continue button at the bottom right' },
    ],
  }));
  const out = await llm.respond({ prompt: 'now what?' });
  // Two steps, so this stays a checklist — the per-step targets are what the
  // watcher uses. Asserting the step kept its target, not the answer path.
  assert.equal(out.kind, 'task');
  assert.equal(out.steps[1].target, 'Continue button at the bottom right');
});

test('respond passes through a target so an ordinary answer can point', async () => {
  const { llm } = stubbed(JSON.stringify({
    kind: 'answer', markdown: 'Right-click the tab.', target: 'the tab in the sidebar', completedStep: 2,
  }));
  const out = await llm.respond({ prompt: 'where?' });
  assert.equal(out.target, 'the tab in the sidebar');
  assert.equal(out.completedStep, 1, 'completedStep arrives 1-based and is used 0-based');
});

test('respond ignores a nonsense completedStep instead of skipping the user ahead', async () => {
  for (const bad of [0, -3, 'two', null, 1.5]) {
    const { llm } = stubbed(JSON.stringify({ kind: 'answer', markdown: 'x', completedStep: bad }));
    const out = await llm.respond({ prompt: 'q' });
    assert.equal(out.completedStep, null, `completedStep ${JSON.stringify(bad)} should be refused`);
  }
});

test('respond shows what the model wrote when it ignores the schema entirely', async () => {
  // A model that returned prose still wrote something useful. Showing it beats
  // showing an error about JSON.
  const { llm } = stubbed('I have no idea what JSON is but the answer is press Ctrl+K.');
  const out = await llm.respond({ prompt: 'q' });
  assert.equal(out.kind, 'answer');
  assert.equal(out.markdown, 'I have no idea what JSON is but the answer is press Ctrl+K.');
});

test('respond survives an empty reply rather than throwing', async () => {
  const { llm } = stubbed('');
  const out = await llm.respond({ prompt: 'q' });
  assert.equal(out.kind, 'answer');
  assert.equal(out.markdown, '');
});

// --- the other two calls ----------------------------------------------------

test('locate sends the image and asks at zero temperature', async () => {
  const { llm, calls } = stubbed('{"found":true,"box_2d":[1,2,3,4]}');
  await llm.locate({ screenshot: PNG, target: 'Save button' });

  assert.equal(calls[0].config.temperature, 0, 'finding a control is not a creative task');
  assert.ok(calls[0].contents[0].parts.some((p) => p.inlineData));
  assert.match(textOf(calls[0]), /Save button/);
});

test('checkStep stays the cheapest call in the product', async () => {
  // It runs far more often than anything else, so its cost decides whether
  // watching is viable at all.
  const { llm, calls } = stubbed('{"status":"pending"}');
  await llm.checkStep({ screenshot: PNG, stepText: 'Open Settings', doneWhen: 'the Settings window is open' });

  const text = textOf(calls[0]);
  assert.match(text, /Open Settings/);
  assert.match(text, /the Settings window is open/);
  assert.equal(calls[0].config.temperature, 0);
  assert.ok(calls[0].config.maxOutputTokens <= 200, `${calls[0].config.maxOutputTokens} tokens is too generous for a yes/no`);
});

test('checkStep falls back to the step text when there is no doneWhen', async () => {
  const { llm, calls } = stubbed('{"status":"pending"}');
  await llm.checkStep({ screenshot: PNG, stepText: 'Open Settings', doneWhen: '' });
  assert.match(textOf(calls[0]), /Complete when: Open Settings/);
});

test('every call uses the model the user chose in Settings', async () => {
  const { llm, calls } = stubbed('{"kind":"answer","markdown":"ok"}');
  await llm.respond({ prompt: 'q' });
  await llm.locate({ screenshot: PNG, target: 't' });
  await llm.checkStep({ screenshot: PNG, stepText: 's', doneWhen: '' });
  for (const call of calls) assert.equal(call.model, 'test/model');
});
