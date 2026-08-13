/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Product behaviour, from the user's seat.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM EVERY OTHER SUITE
 *
 * On 2026-08-10 a live demo asked "how do I route my internet through my other
 * computer?" over Tailscale's Exit Nodes pane. Handrail replied with a correct
 * opening sentence, a colon, and then nothing. No list. No arrow.
 *
 * Every suite was green. They still would have been. Here is what each one
 * actually checks:
 *
 *   - the unit tests check that functions return what they are asked for
 *   - `smoke.js` checks that the main process boots and its IPC works
 *   - the Playwright suite checks that the renderer draws and responds
 *   - `verify:mac` checks that the packaged bundle starts
 *   - `doctor` checks the machine around the app
 *
 * Not one of them asks the only question a user cares about: GIVEN A REAL
 * QUESTION, IS THE REPLY ANY GOOD? A reply that ends on a dangling colon is
 * perfectly valid markdown, arrives without an error, renders without a crash,
 * and satisfies every check above. It is also useless.
 *
 * So these tests are written as scenarios — a real user, a real screen, a real
 * question — and they assert the things a person would notice. The model is
 * stubbed with the shapes models genuinely return, including the malformed
 * ones, because the point is to pin Handrail's behaviour, not the model's.
 *
 * ADDING A SCENARIO: describe the situation in words first, then assert only
 * what a user would complain about. If an assertion would not appear in a bug
 * report, it belongs in one of the other suites.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Llm } = require('./llm');

const PNG = Buffer.from('fake screenshot bytes');

/** An Llm whose provider returns exactly `text`. */
function handrailReturning(text) {
  return new Llm(
    () => 'sk-or-v1-test',
    () => 'test/model',
    () => ({ models: { generateContent: async () => ({ text }) } }),
  );
}

/**
 * The invariants that hold for EVERY reply, whatever was asked.
 *
 * Each one is a bug that has actually shipped, or came within one code path of
 * shipping, in this product.
 */
function assertUsable(result, where) {
  const shown = result.kind === 'task'
    ? result.steps.map((s) => s.text).join('\n')
    : String(result.markdown || '');

  assert.ok(shown.trim(), `${where}: the user was shown nothing at all`);

  assert.ok(
    !/^\s*[{[]/.test(shown) && !shown.includes('"kind"'),
    `${where}: raw JSON reached the user — ${JSON.stringify(shown.slice(0, 80))}`,
  );

  assert.ok(
    !/[:;,]\s*$/.test(shown),
    `${where}: the reply ends on a dangling lead-in — ${JSON.stringify(shown.slice(-60))}`,
  );

  assert.ok(
    !/\b(here'?s|here is|as follows|the steps are|do the following)\s*$/i.test(shown.trim()),
    `${where}: the reply promises something it never delivers — ${JSON.stringify(shown.slice(-60))}`,
  );
}

// --- Scenario 1 -------------------------------------------------------------
//
// THE DEMO FAILURE. Tailscale is open on "Exit Nodes", showing "No available
// exit nodes". The user asks "how do I route my internet through my other
// computer?" — which reads like one action and is five.
//
// The model answers in the shape it genuinely used: a lead-in AND a list, with
// `kind` set to "answer" rather than "task". Handrail used to show the lead-in
// and bin the list.

test('scenario: a multi-step job asked as if it were one click', async () => {
  const llm = handrailReturning(JSON.stringify({
    kind: 'answer',
    markdown: 'Routing through your other computer means turning it into a Tailscale '
      + 'exit node — the **Exit Nodes** panel you have open is exactly where that gets '
      + "configured. Here's the full path:",
    target: 'Exit Nodes row in the left sidebar',
    steps: [
      { text: 'On the other computer, run `tailscale up --advertise-exit-node`' },
      { text: 'Approve it in the Tailscale admin console' },
      { text: 'Back on this Mac, choose it under **Exit Nodes**' },
    ],
  }));

  const result = await llm.respond({
    prompt: 'how do I route my internet through my other computer?',
    screenshot: PNG,
  });

  assertUsable(result, 'tailscale exit node');
  assert.ok(result.markdown.includes('advertise-exit-node'), 'the promised steps must reach the user');
  assert.ok(result.markdown.includes('- Approve it'), 'more than one step renders as a list');
  assert.ok(result.target, 'a reply naming an on-screen control must carry a target, or there is no arrow');
});

// --- Scenario 2 -------------------------------------------------------------
//
// THE ARROW IS THE PRODUCT. The user cannot find something and says so. Nothing
// else Handrail does is unique; this is. A reply to "where is X" that carries
// no target is a silent product failure — it looks like a perfectly good answer
// and simply never points.

test('scenario: "where is it?" always leaves something for the arrow', async () => {
  const llm = handrailReturning(JSON.stringify({
    kind: 'answer',
    markdown: 'It is the **gear icon** at the bottom left of the sidebar.',
    target: 'gear icon at the bottom left',
  }));

  const result = await llm.respond({ prompt: 'where are the settings?', screenshot: PNG });

  assertUsable(result, 'where is it');
  assert.equal(result.target, 'gear icon at the bottom left');
  assert.ok(result.markdown.length < 200, 'a "where is" answer is one sentence, not an essay');
});

test('scenario: a checklist points at its first real control', async () => {
  const llm = handrailReturning(JSON.stringify({
    kind: 'task',
    title: 'Trim the clip',
    steps: [
      { text: 'Wait for the render to finish', target: '' },
      { text: 'Select the Razor tool', target: 'Razor tool in the left toolbar' },
      { text: 'Click where you want the cut' },
    ],
  }));

  const result = await llm.respond({ prompt: 'how do I cut this clip in half?', screenshot: PNG });

  assert.equal(result.kind, 'task');
  assertUsable(result, 'razor checklist');
  // A step with nothing to click must not swallow the arrow.
  assert.equal(result.steps[0].target, '');
  assert.equal(result.steps[1].target, 'Razor tool in the left toolbar');
});

// --- Scenario 3 -------------------------------------------------------------
//
// RESTRAINT. A yes/no question must not become a project plan. This failed in
// the opposite direction before — removing the length ceiling let a one-word
// question produce four paragraphs (see prompts.js) — so the guard belongs in
// a test, not only in a prompt.

test('scenario: a yes/no question does not become a checklist', async () => {
  const llm = handrailReturning(JSON.stringify({
    kind: 'answer',
    markdown: 'Yes, it is safe — that setting only affects this Mac, and you can turn it back off at any time.',
  }));

  const result = await llm.respond({ prompt: 'is it safe to turn this on?', screenshot: PNG });

  assertUsable(result, 'yes/no');
  assert.notEqual(result.kind, 'task', 'a yes/no answer is never a checklist');
  assert.ok(!result.markdown.includes('\n- '), 'no bullet list for a yes/no question');
  assert.equal(result.target, '', 'nothing to click means no arrow, not a wrong arrow');
});

// --- Scenario 4 -------------------------------------------------------------
//
// THE MODEL MISBEHAVES. It will. These are the four ways it has actually
// misbehaved against this product. In every one of them the user must still get
// something readable, and must never see the machinery.

test('scenario: the model ignores the schema and just talks', async () => {
  const llm = handrailReturning('Click the **Exit Nodes** row, then pick your other computer.');
  const result = await llm.respond({ prompt: 'how do I do this?', screenshot: PNG });

  assertUsable(result, 'plain prose reply');
  assert.equal(result.kind, 'answer');
  assert.ok(result.markdown.startsWith('Click the'));
});

test('scenario: the model wraps its JSON in chat and code fences', async () => {
  const llm = handrailReturning(
    'Sure! Here you go:\n```json\n{"kind":"answer","markdown":"Press **Cmd+,** to open Settings."}\n```',
  );
  const result = await llm.respond({ prompt: 'how do I open settings?', screenshot: PNG });

  assertUsable(result, 'fenced json');
  assert.equal(result.markdown, 'Press **Cmd+,** to open Settings.');
});

test('scenario: the model sends a one-step "checklist"', async () => {
  const llm = handrailReturning(JSON.stringify({
    kind: 'task',
    title: 'Turn on dark mode',
    steps: [{ text: 'Click **Appearance** and choose Dark', target: 'Appearance in the sidebar' }],
  }));
  const result = await llm.respond({ prompt: 'how do I turn on dark mode?', screenshot: PNG });

  assertUsable(result, 'one-step task');
  assert.notEqual(result.kind, 'task', 'a checklist of one is a sentence, not a checklist');
  assert.ok(!result.markdown.includes('{'), 'and it must never be shown as the raw JSON it arrived as');
  assert.equal(result.target, 'Appearance in the sidebar', 'the single step still aims the arrow');
});

test('scenario: the model returns an empty reply', async () => {
  const llm = handrailReturning('');
  const result = await llm.respond({ prompt: 'what is this?', screenshot: PNG });

  // Nothing usable came back. The one thing that must not happen is Handrail
  // inventing an answer — an empty string is honest, a hallucinated one is not.
  assert.equal(result.kind, 'answer');
  assert.equal(result.markdown, '');
});

// --- Scenario 5 -------------------------------------------------------------
//
// THE LOCATOR'S TOKEN BUDGET.
//
// `locate` asked for 300 output tokens because its reply is four numbers. That
// held until the default model became a reasoning model, which charges its
// thinking against the same budget: the locator spent all 300 reasoning,
// returned empty text, and the arrow silently never drew — after a real
// four-second call, with the target correctly identified. Every other call site
// asked for 3000. This one was sized for a model generation that no longer
// exists.

test('scenario: the locator asks for enough tokens to survive a thinking model', async () => {
  const sent = [];
  const llm = new Llm(
    () => 'sk-or-v1-test',
    () => 'test/model',
    () => ({
      models: {
        generateContent: async (req) => { sent.push(req); return { text: '{"box_2d":[10,20,30,40]}' }; },
      },
    }),
  );

  await llm.locate({ screenshot: PNG, target: 'Night Shift button' });

  const cap = sent[0].config.maxOutputTokens;
  assert.ok(
    cap >= 1000,
    `the locator asked for only ${cap} output tokens — a reasoning model spends its `
    + 'budget thinking and returns empty text, which reads as "control not found"',
  );
});

test('scenario: an empty locator reply does not crash, it reports nothing found', async () => {
  const llm = new Llm(
    () => 'sk-or-v1-test',
    () => 'test/model',
    () => ({ models: { generateContent: async () => ({ text: '' }) } }),
  );
  assert.equal(await llm.locate({ screenshot: PNG, target: 'anything' }), null);
});

// --- Scenario 6 -------------------------------------------------------------
//
// ATTACHMENTS. A file attached to the thread has to reach the model labelled by
// name, so a reply can say WHICH file it is quoting, and the bytes must never
// be mistaken for the screenshot.

test('scenario: an attached text file reaches the model, named', async () => {
  const sent = [];
  const llm = new Llm(
    () => 'sk-or-v1-test',
    () => 'test/model',
    () => ({
      models: {
        generateContent: async (req) => { sent.push(req); return { text: '{"kind":"answer","markdown":"ok"}' }; },
      },
    }),
  );

  await llm.respond({
    prompt: 'what is the error in this log?',
    screenshot: PNG,
    attachments: [{ kind: 'text', name: 'build.log', text: 'FATAL: disk full' }],
  });

  const text = sent[0].contents[0].parts.map((p) => p.text || '').join('\n');
  assert.ok(text.includes('build.log'), 'the model must know which file it is reading');
  assert.ok(text.includes('FATAL: disk full'), 'the contents must actually be sent');
});

test('scenario: an attached image is sent as an image, not as text', async () => {
  const sent = [];
  const llm = new Llm(
    () => 'sk-or-v1-test',
    () => 'test/model',
    () => ({
      models: {
        generateContent: async (req) => { sent.push(req); return { text: '{"kind":"answer","markdown":"ok"}' }; },
      },
    }),
  );

  await llm.respond({
    prompt: 'what is this?',
    screenshot: PNG,
    screenshotMime: 'image/jpeg',
    attachments: [{ kind: 'image', name: 'error.png', mimeType: 'image/png', data: 'AAAA' }],
  });

  const parts = sent[0].contents[0].parts;
  const images = parts.filter((p) => p.inlineData);
  assert.equal(images.length, 2, 'the screenshot AND the attachment');
  assert.equal(images[0].inlineData.mimeType, 'image/jpeg', 'the screenshot keeps its real type');
  assert.equal(images[1].inlineData.mimeType, 'image/png', 'the attachment keeps its own');
});

test('scenario: a truncated attachment says so rather than lying by omission', async () => {
  const sent = [];
  const llm = new Llm(
    () => 'sk-or-v1-test', () => 'test/model',
    () => ({ models: { generateContent: async (req) => { sent.push(req); return { text: '{}' }; } } }),
  );
  await llm.respond({
    prompt: 'summarise',
    attachments: [{ kind: 'text', name: 'huge.csv', text: 'a,b,c', truncated: true }],
  });
  const text = sent[0].contents[0].parts.map((p) => p.text || '').join('\n');
  assert.ok(/truncated/i.test(text), 'the model must know it is not seeing the whole file');
});

// --- Scenario 7 -------------------------------------------------------------
//
// WEB SEARCH. Off unless asked for, and never on the two passes that are
// questions about the screenshot rather than about the world.

test('scenario: web search is off unless the turn asks for it', async () => {
  const sent = [];
  const llm = new Llm(
    () => 'sk-or-v1-test', () => 'test/model',
    () => ({ models: { generateContent: async (req) => { sent.push(req); return { text: '{}' }; } } }),
  );

  await llm.respond({ prompt: 'where is settings?', screenshot: PNG });
  assert.ok(!sent[0].web, 'no web unless requested');

  await llm.respond({ prompt: 'what changed in the latest release?', screenshot: PNG, web: true });
  assert.equal(sent[1].web, true, 'requested, so passed through');
});

test('scenario: locating a control never searches the web', async () => {
  const sent = [];
  const llm = new Llm(
    () => 'sk-or-v1-test', () => 'test/model',
    () => ({ models: { generateContent: async (req) => { sent.push(req); return { text: '{"box_2d":[1,2,3,4]}' }; } } }),
  );
  await llm.locate({ screenshot: PNG, target: 'Night Shift button' });
  assert.ok(!sent[0].web, 'where a button is on screen is not a question for a search engine');
});
