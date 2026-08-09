/**
 * Nothing the model returns may reach the user as raw JSON.
 *
 * `answerFrom` is the fall-through for a response that claimed to be a task but
 * did not qualify as a checklist. It used to be `res.text` — the whole JSON
 * blob — which is what a valid one-step plan was shown to the user as.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { answerFrom, parseJson } = require('./llm');

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
