/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Nothing the model returns may reach the user as raw JSON.
 *
 * `answerFrom` is the fall-through for a response that claimed to be a task but
 * did not qualify as a checklist. It used to be `res.text` — the whole JSON
 * blob — which is what a valid one-step plan was shown to the user as.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { answerFrom, parseJson, targetFrom } = require('./llm');

const RAW = '{"kind":"task","title":"Turn on dark mode","steps":[{"text":"Click Appearance"}]}';

test('a one-step plan becomes prose, not JSON', () => {
  const out = answerFrom(parseJson(RAW), RAW);
  assert.equal(out, 'Click Appearance');
  assert.ok(!out.includes('{'), 'must not leak JSON at the user');
});

test('written prose always wins', () => {
  const parsed = { kind: 'answer', markdown: 'Press **Ctrl+K**.' };
  assert.equal(answerFrom(parsed, RAW), 'Press **Ctrl+K**.');
});

test('the older `answer` field still works', () => {
  assert.equal(answerFrom({ answer: 'Top right.' }, RAW), 'Top right.');
});

test('several steps with no prose become a list under the title', () => {
  const parsed = { kind: 'task', title: 'Two things', steps: [{ text: 'One' }, { text: 'Two' }] };
  assert.equal(answerFrom(parsed, RAW), '**Two things**\n\n- One\n- Two');
});

test('blank steps are dropped, and empty ones fall back to the raw text', () => {
  assert.equal(answerFrom({ kind: 'task', steps: [{ text: '  ' }, {}] }, 'plain reply'), 'plain reply');
});

test('a task with one real step among blanks is still a sentence', () => {
  const parsed = { kind: 'task', title: 'T', steps: [{ text: '' }, { text: 'Do it' }] };
  assert.equal(answerFrom(parsed, RAW), 'Do it');
});

test('parseJson digs a fenced object out of prose', () => {
  const parsed = parseJson('Sure!\n```json\n{"kind":"answer","markdown":"hi"}\n```');
  assert.equal(parsed.markdown, 'hi');
});

test('parseJson gives up rather than guessing', () => {
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson(''), null);
});

/**
 * The demo failure, reduced to its smallest form.
 *
 * Asked "how do I route my internet through my other computer?" over the
 * Tailscale Exit Nodes pane, the model returned a lead-in ending in a colon
 * AND a list of steps. `kind` was not exactly "task", so the caller's checklist
 * branch did not fire, and `answerFrom` returned the prose and dropped the
 * steps — so the user was shown a sentence promising a list, a colon, and
 * nothing else, with no arrow.
 *
 * The rule these lock in: whatever shape the model picks, nothing it wrote is
 * discarded, and no reply ends on a dangling lead-in.
 */

const ENDS_DANGLING = /[:;,]\s*$|\b(here's|here is|as follows|the steps are|do this)\s*$/i;

test('a multi-step question that opens like a single-step one keeps its list', () => {
  const parsed = {
    kind: 'answer',
    markdown: "Routing through your other computer means turning it into a Tailscale exit "
      + "node — the **Exit Nodes** panel you have open is exactly where that gets "
      + "configured. Here's the full path:",
    steps: [
      { text: 'On the other computer, run `tailscale up --advertise-exit-node`' },
      { text: 'Approve it in the Tailscale admin console' },
      { text: 'Back on this Mac, pick it under **Exit Nodes**' },
    ],
  };

  const out = answerFrom(parsed, '{}');

  assert.ok(!ENDS_DANGLING.test(out), `reply must not end on a dangling lead-in: ${JSON.stringify(out)}`);
  assert.ok(out.includes('advertise-exit-node'), 'the promised steps must survive');
  assert.ok(out.includes('- Approve it'), 'several steps render as a list');
  assert.ok(out.startsWith('Routing through'), 'the lead-in is kept too');
});

test('prose plus a single step keeps both', () => {
  const parsed = {
    kind: 'task',
    title: 'Turn on the exit node',
    markdown: 'You only need one thing here:',
    steps: [{ text: 'Tick **Use exit node**' }],
  };
  const out = answerFrom(parsed, '{}');
  assert.equal(out, 'You only need one thing here:\n\nTick **Use exit node**');
  assert.ok(!ENDS_DANGLING.test(out));
});

test('a lead-in with no steps at all is left exactly as written', () => {
  // Not answerFrom's job to invent content it was never given — this one is on
  // the prompt, which now forbids announcing a list it does not write.
  const out = answerFrom({ kind: 'answer', markdown: 'Here goes:' }, '{}');
  assert.equal(out, 'Here goes:');
});

test('steps still render when the model forgot to say kind:"task"', () => {
  const parsed = { kind: 'answer', steps: [{ text: 'One' }, { text: 'Two' }] };
  assert.equal(answerFrom(parsed, 'raw fallback'), '- One\n- Two');
});

/**
 * The arrow half of the same demo failure.
 *
 * No arrow appeared. `targetFrom` reads a top-level "target" first and then
 * falls back to the first step that names one, so a hybrid reply must not lose
 * the target either — whichever of the two places the model put it.
 */

test('a hybrid reply keeps its top-level target', () => {
  const parsed = {
    kind: 'answer',
    markdown: 'Turn it on here:',
    target: 'Exit Nodes row in the left sidebar',
    steps: [{ text: 'Pick the other computer' }],
  };
  assert.equal(targetFrom(parsed), 'Exit Nodes row in the left sidebar');
});

test('a hybrid reply falls back to the first step that names a target', () => {
  const parsed = {
    kind: 'answer',
    markdown: 'Two things:',
    steps: [
      { text: 'Wait for it to connect' },
      { text: 'Choose the exit node', target: 'Use exit node checkbox' },
    ],
  };
  assert.equal(targetFrom(parsed), 'Use exit node checkbox');
});

test('no target anywhere is an empty string, never undefined', () => {
  assert.equal(targetFrom({ kind: 'answer', markdown: 'Nothing to click.' }), '');
});
