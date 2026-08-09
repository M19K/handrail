/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — run one real screenshot past several models and read the answers.
 *
 * The standing complaint about this product is that it invents menu paths for
 * UI that is not on screen. `src/main/prompts.js` already tells the model in as
 * many words never to do that, so the question is which models actually obey.
 * That is not answerable by reasoning about it; it needs the real screen, the
 * real prompt and the real answers next to each other.
 *
 *   npx electron scripts/compare-models.js "where do I change the theme?"
 *   npx electron scripts/compare-models.js --shot C:\path\to\screen.png "..."
 *   npx electron scripts/compare-models.js --models a,b,c "..."
 *
 * The key comes from the app's own encrypted store, so once it is entered in
 * Handrail this needs no further setup. `OPENROUTER_API_KEY` in `.env` wins if
 * it is set, which is the dev path.
 *
 * Costs real money. Every model runs one vision call per question, so the
 * default list of four is roughly a penny.
 */

const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

app.setName('Handrail');

const { Store } = require('../src/main/store');
const { Llm } = require('../src/main/llm');
const { captureDisplay } = require('../src/main/capture');

/**
 * Candidates, cheapest first, with OpenRouter's per-million prices at the time
 * of writing. Prices move; `hr:models:list` fetches the live ones.
 */
const DEFAULT_MODELS = [
  { id: 'google/gemini-3.5-flash-lite', inP: 0.30, outP: 2.50 },  // the old default
  { id: 'google/gemini-3.5-flash',      inP: 1.50, outP: 9.00 },  // the new default
  { id: 'openai/gpt-5-mini',            inP: 0.25, outP: 2.00 },
  { id: 'anthropic/claude-haiku-4.5',   inP: 1.00, outP: 5.00 },
];

function parseArgs(argv) {
  const out = { models: null, shot: null, prompt: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--models') { out.models = argv[++i].split(',').map((s) => s.trim()); continue; }
    if (argv[i] === '--shot') { out.shot = argv[++i]; continue; }
    rest.push(argv[i]);
  }
  out.prompt = rest.join(' ').trim();
  return out;
}

/** Rough token estimate. Enough to compare models, not to bill anyone. */
const estimateTokens = (chars) => Math.ceil(chars / 4);

app.whenReady().then(async () => {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt || 'What is on my screen, and what should I click next?';

  const store = new Store();
  const key = store.getKey();
  if (!key) {
    console.error('\nNo API key.');
    console.error('Either open Handrail and enter one, or put OPENROUTER_API_KEY in .env.');
    console.error(store.keyProblem === 'unreadable'
      ? 'The stored key exists but this machine can no longer decrypt it — re-enter it in Handrail.\n'
      : '');
    app.exit(1);
    return;
  }

  // The real screen, at native resolution, exactly as a turn would capture it.
  let buffer;
  if (args.shot) {
    buffer = fs.readFileSync(args.shot);
    console.log(`screenshot : ${args.shot} (${(buffer.length / 1024).toFixed(0)} KB)`);
  } else {
    const display = screen.getPrimaryDisplay();
    const shot = await captureDisplay(display, 'full');
    buffer = shot.buffer;
    const file = path.join(os.tmpdir(), 'handrail-compare.png');
    fs.writeFileSync(file, buffer);
    console.log(`screenshot : primary display, ${shot.size.width}x${shot.size.height} -> ${file}`);
  }

  const models = args.models
    ? args.models.map((id) => DEFAULT_MODELS.find((m) => m.id === id) || { id, inP: 0, outP: 0 })
    : DEFAULT_MODELS;

  console.log(`question   : ${prompt}`);
  console.log(`models     : ${models.length}\n`);

  const results = [];
  for (const model of models) {
    // One Llm per model, because the model is read from a getter.
    const llm = new Llm(() => key, () => model.id);
    const started = Date.now();
    try {
      const res = await llm.respond({ prompt, screenshot: buffer, history: [] });
      const ms = Date.now() - started;

      // Image tokens dominate and are not reported back, so this is indicative.
      const inTok = estimateTokens(buffer.toString('base64').length / 3) + estimateTokens(prompt.length);
      const body = res.kind === 'task'
        ? `${res.title}\n${res.steps.map((s, i) => `  ${i + 1}. ${s.text}${s.target ? `   [target: ${s.target}]` : ''}`).join('\n')}`
        : res.markdown;
      const outTok = estimateTokens(body.length);
      const cost = (inTok * model.inP + outTok * model.outP) / 1e6;

      results.push({ id: model.id, ms, kind: res.kind, cost, body, target: res.target || '' });

      console.log('='.repeat(76));
      console.log(`${model.id}   ${ms}ms   ${res.kind}   ~$${cost.toFixed(4)}`);
      console.log('='.repeat(76));
      console.log(body);
      if (res.target) console.log(`\n[wants to point at: ${res.target}]`);
      console.log('');
    } catch (err) {
      console.log('='.repeat(76));
      console.log(`${model.id}   FAILED after ${Date.now() - started}ms`);
      console.log(`  ${err.message}`);
      console.log('');
      results.push({ id: model.id, error: err.message });
    }
  }

  // --- what to actually look for -------------------------------------------
  console.log('-'.repeat(76));
  console.log('Read the answers, not the timings. The thing being tested is whether a');
  console.log('model states a menu path it cannot see in the screenshot. prompts.js');
  console.log('already forbids that, so any model doing it is ignoring the instruction.');
  console.log('');
  console.log('  good : names only what is visible, then says how to reach the rest');
  console.log('  bad  : "go to Settings > Appearance > Theme" when none of that is on screen');
  console.log('');
  for (const r of results) {
    if (r.error) { console.log(`  ${r.id.padEnd(34)} failed`); continue; }
    console.log(`  ${r.id.padEnd(34)} ${String(r.ms + 'ms').padStart(7)}  ~$${r.cost.toFixed(4)}  ${r.kind}`);
  }

  const file = path.join(os.tmpdir(), 'handrail-model-comparison.json');
  fs.writeFileSync(file, JSON.stringify({ prompt, results }, null, 2));
  console.log(`\nfull output: ${file}`);

  app.exit(0);
});
