/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Output-token budgets, because one of them silently broke the whole product.
 *
 * `locate()` was capped at 300. The reply it needs to return is about 40
 * tokens, so that looked generous — but a reasoning model spends the budget
 * THINKING before it emits anything, and "where is this control in a 2880x1800
 * screenshot" is exactly what it thinks hardest about. The budget ran out
 * mid-answer:
 *
 *     {"found":true,"label":"speaker icon","box_
 *
 * `parseJson` correctly refuses that, so `locate()` returned null,
 * `_pointAtTarget` read it as "control not found", and no arrow was ever drawn.
 * No error and no log line — it looked exactly like the model failing to find
 * the control. The arrow is the one thing this product does that nothing else
 * does, and it was dead on the default model.
 *
 * These tests capture what is actually sent to the provider and assert the
 * budgets are big enough to survive a thinking model. They cost nothing and
 * they are the only thing standing between someone "tidying up" a number and
 * silently removing the headline feature again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

/** Capture every request the Llm makes, without touching the network. */
function captureRequests() {
  const sent = [];
  const originalLoad = Module._load;

  Module._load = function stub(request, ...rest) {
    if (request === 'electron') return { app: { getPath: () => '.' }, safeStorage: {} };
    if (/openrouter\.adapter/.test(request)) {
      return {
        OpenRouterClient: class {
          constructor() {
            this.models = {
              generateContent: async (req) => {
                sent.push(req);
                return { text: '{"found":true,"label":"x","box_2d":[1,2,3,4]}' };
              },
              generateContentStream: async () => (async function* () { yield { text: 'x' }; })(),
            };
          }
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };

  delete require.cache[require.resolve('./llm')];
  const { Llm } = require('./llm');
  Module._load = originalLoad;
  delete require.cache[require.resolve('./llm')];

  return { Llm, sent };
}

const PNG = Buffer.from('fake png bytes');

test('locate asks for enough tokens to survive a reasoning model', async () => {
  const { Llm, sent } = captureRequests();
  const llm = new Llm(() => 'sk-or-v1-test', () => 'google/gemini-3.5-flash');

  await llm.locate({ screenshot: PNG, target: 'the speaker icon' });

  assert.equal(sent.length, 1);
  const budget = sent[0].config.maxOutputTokens;
  assert.ok(
    budget >= 1000,
    `locate() asked for ${budget} output tokens. Measured: gemini-3.5-flash truncates `
    + 'mid-JSON at 300 and completes at 2000. Below ~1000 the arrow stops being drawn '
    + 'and nothing reports why.',
  );
});

test('the two calls that write prose have room for prose', async () => {
  const { Llm, sent } = captureRequests();
  const llm = new Llm(() => 'sk-or-v1-test', () => 'google/gemini-3.5-flash');

  await llm.respond({ prompt: 'how do I do the thing?', screenshot: PNG, history: [] });

  const budget = sent[0].config.maxOutputTokens;
  assert.ok(budget >= 2000, `respond() asked for only ${budget} output tokens`);
});

test('every request carries the model and the abort signal through', async () => {
  const { Llm, sent } = captureRequests();
  const llm = new Llm(() => 'sk-or-v1-test', () => 'test/model');
  const controller = new AbortController();

  await llm.locate({ screenshot: PNG, target: 'x', signal: controller.signal });

  assert.equal(sent[0].model, 'test/model');
  assert.equal(sent[0].signal, controller.signal, 'Escape has to reach fetch, not just be recorded');
});
