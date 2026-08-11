/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * Handrail — model client.
 *
 * Replaces `src/services/llm.service.js` (1,710 lines of Gemini-native
 * plumbing, model fallback chains, retry ladders and interview-specific
 * prompt injection). Handrail makes four kinds of request and this file makes
 * exactly those four.
 *
 * Everything speaks OpenAI-shaped JSON to OpenRouter through
 * `openrouter.adapter.js`, which is already tested.
 */

const { OpenRouterClient } = require('../services/openrouter.adapter');
const { PLAN_SYSTEM, ANSWER_SYSTEM, LOCATE_SYSTEM, CHECK_SYSTEM } = require('./prompts');

/** Strip fences and prose, then parse. Models add wrapping however firmly asked not to. */
function parseJson(text) {
  if (!text || !text.trim()) return null;
  const trimmed = text.trim();

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* next */ }
  }
  return null;
}

function imagePart(buffer) {
  return { inlineData: { mimeType: 'image/png', data: buffer.toString('base64') } };
}

/**
 * Recent turns, as an actual transcript.
 *
 * This used to send `t.summary`, which for a checklist was only its title — so
 * the model's view of the conversation was a list of repeated headings with no
 * replies in it, and it had nothing to be conversational about. Six turns
 * rather than four: follow-ups like "now what?" are short, so the useful
 * context is further back than it looks.
 */
function formatHistory(history) {
  if (!history || !history.length) return '';

  return history.slice(-6).map((turn) => {
    let reply;
    if (turn.kind === 'task') {
      const steps = (turn.steps || []).map((s, i) => `  ${i + 1}. ${s.text}`).join('\n');
      reply = `[gave them a checklist: "${turn.title}"]\n${steps}`;
    } else {
      reply = String(turn.markdown || turn.summary || '').slice(0, 500);
    }
    return `User: ${turn.prompt}\nYou: ${reply}`;
  }).join('\n\n');
}

/**
 * The prose for an answer, including a plan too short to be a checklist.
 *
 * The task branch requires more than one step, so a model that correctly
 * returned `kind:"task"` with a single step fell through to here — where
 * `markdown` is absent and the fallback was `res.text`, i.e. the whole JSON
 * blob, printed at the user verbatim. Never showing raw JSON matters more than
 * where the text came from.
 */
/** The step texts as markdown, or '' when there are none worth showing. */
function stepsMarkdown(parsed) {
  if (!Array.isArray(parsed.steps)) return '';
  const steps = parsed.steps
    .map((s) => String((s && s.text) || '').trim())
    .filter(Boolean);
  if (!steps.length) return '';
  // One step is a sentence, not a list.
  return steps.length === 1 ? steps[0] : steps.map((t) => `- ${t}`).join('\n');
}

function answerFrom(parsed, raw) {
  const written = String(parsed.markdown || parsed.answer || '').trim();
  const list = stepsMarkdown(parsed);

  // A reply that carries BOTH prose and steps keeps both.
  //
  // This used to return `written` and stop, which silently threw the steps
  // away. The model does not always split cleanly down the two shapes the
  // schema offers: asked something multi-step that opens like a single action,
  // it writes a lead-in AND a list. If that lead-in ends on a colon — "here's
  // the full path:" — and `kind` is not exactly "task", or the list is one step
  // long, the caller's checklist branch does not fire either, and the user is
  // shown a sentence promising a list that was generated and then discarded.
  // Whatever the model returns, nothing it wrote is dropped on the floor.
  if (written && list) return `${written}\n\n${list}`;
  if (written) return written;

  if (list) {
    const title = String(parsed.title || '').trim();
    const multi = list.startsWith('- ');
    return parsed.kind === 'task' && title && multi ? `**${title}**\n\n${list}` : list;
  }

  return String(raw || '').trim();
}

/**
 * What the arrow should point at, wherever the model put it.
 *
 * The schema has two homes for `target`: top level on an answer, and per-step
 * inside a checklist. A ONE-STEP plan is turned into prose by `answerFrom` and
 * returned as an answer — and the answer branch only ever read the top-level
 * field, which a task-shaped reply does not have. So a model that correctly
 * said "click the Razor tool", as a single step, produced prose telling the
 * user to click something and no arrow at all.
 *
 * Silent, and invisible from either end. The reply looked right, `turn.js`
 * never entered `_pointAtTarget` because `result.target` was empty, and nothing
 * was logged because nothing had failed. The arrow is the one thing this
 * product does that nothing else does, so the path that quietly skips it is
 * worth more care than the path that errors.
 */
function targetFrom(parsed) {
  const top = parsed.target ? String(parsed.target).trim() : '';
  if (top) return top;

  // The first step that names something — a plan whose opening step is
  // "wait for the installer to finish" legitimately has no target, and the
  // arrow belongs on the first step that does.
  if (Array.isArray(parsed.steps)) {
    for (const step of parsed.steps) {
      const t = step && step.target ? String(step.target).trim() : '';
      if (t) return t;
    }
  }

  return '';
}

/**
 * The shape `Llm` needs from a provider client.
 *
 * Written down because `makeClient` used to be documented as returning
 * `object`, which told a reader nothing and told a typechecker less — every
 * `client.models.…` call read as an error against a type that allowed no
 * properties at all. This is also the contract a test double has to meet, and
 * `respond()` is only testable because a double can be passed in.
 *
 * @typedef {{ text?: string }} ModelResponse the only field we read off a reply
 *
 * @typedef {object} ProviderClient
 * @property {object} models
 * @property {(req: object) => Promise<ModelResponse>} models.generateContent
 * @property {(req: object) => Promise<AsyncIterable<ModelResponse>>} models.generateContentStream
 */

/**
 * What a single model request can be tuned with.
 *
 * @typedef {object} RequestOptions
 * @property {number} [temperature]
 * @property {number} [maxOutputTokens]
 * @property {AbortSignal} [signal] threaded all the way to fetch, so Escape
 *   actually cancels the upstream call instead of only discarding its reply
 */

class Llm {
  /**
   * @param {() => string|null} getKey
   * @param {() => string} getModel
   * @param {(opts: {apiKey: string}) => ProviderClient} [makeClient] how to build the
   *   provider client. Defaults to the real OpenRouter one; the only reason it
   *   is injectable is that `respond()` was the single load-bearing function in
   *   the product with no test at all — the client was constructed inside
   *   `_client()`, so there was no seam to test through without a network call
   *   and a funded key.
   */
  constructor(getKey, getModel, makeClient) {
    this.getKey = getKey;
    this.getModel = getModel;
    this.makeClient = makeClient || ((opts) => new OpenRouterClient(opts));
  }

  _client() {
    const key = this.getKey();
    if (!key) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('No API key set. Add one in Settings.')
      );
      err.code = 'NO_KEY';
      throw err;
    }
    return this.makeClient({ apiKey: key });
  }

  /**
   * `signal` is threaded all the way to fetch. Without it, cancelling a slow
   * vision call left the request running and billed — only the reply was
   * discarded — so Escape looked like a cancel and was not one.
   *
   * @param {string} system
   * @param {object[]} parts
   * @param {RequestOptions} [opts]
   */
  _req(system, parts, { temperature = 0.2, maxOutputTokens = 1400, signal } = {}) {
    return {
      model: this.getModel(),
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      config: { temperature, maxOutputTokens },
      signal,
    };
  }

  /**
   * Decide whether this is a question or a task, and answer or plan accordingly.
   *
   * One call, not two. A separate classify-then-act pass would double latency
   * and cost on every single prompt to save nothing — the model has to read the
   * screenshot either way, and it is perfectly capable of choosing its own
   * output shape. The checklist appearing only for genuinely multi-step work is
   * a product requirement (PRODUCT.md); making it a separate request would not
   * make it more reliable.
   */
  async respond({ prompt, screenshot, history, activeTask, signal }) {
    const parts = [];
    if (screenshot) parts.push(imagePart(screenshot));

    const transcript = formatHistory(history);
    if (transcript) {
      parts.push({ text: `Earlier in this conversation:\n\n${transcript}\n\n---\n\n` });
    }

    // Telling the model a checklist is already running is what stops "now what?"
    // producing a second copy of the same checklist. Without it the model has no
    // way to know the plan it is about to write already exists.
    if (activeTask) {
      const steps = activeTask.steps
        .map((s, i) => `  ${i + 1}. [${s.status === 'done' ? 'done' : s.status === 'active' ? 'CURRENT' : 'to do'}] ${s.text}`)
        .join('\n');
      parts.push({
        text:
          `A checklist is ALREADY RUNNING. Do not create another one unless the ` +
          `user has clearly changed goal.\n\n"${activeTask.title}"\n${steps}\n\n` +
          `They are on step ${activeTask.activeIndex + 1}. If this message is ` +
          `about that, answer it — do not re-issue the checklist.\n\n---\n\n`,
      });
    }

    parts.push({ text: prompt });

    const res = await this._client().models.generateContent(
      this._req(PLAN_SYSTEM, parts, { temperature: 0.3, maxOutputTokens: 3000, signal })
    );

    const parsed = parseJson(res.text);
    if (!parsed) {
      // Not a failure. A model that ignored the schema still wrote something
      // useful, and showing it beats showing an error about JSON.
      return { kind: 'answer', markdown: (res.text || '').trim() };
    }

    if (parsed.kind === 'task' && Array.isArray(parsed.steps) && parsed.steps.length > 1) {
      return {
        kind: 'task',
        title: String(parsed.title || prompt).slice(0, 90),
        steps: parsed.steps.slice(0, 12).map((s) => ({
          text: String(s.text || '').trim(),
          hint: s.hint ? String(s.hint).trim() : '',
          // The visual criterion that makes step-watching cheap. Stays in main;
          // the renderer has no use for it. See PRODUCT.md § Step completion.
          doneWhen: s.doneWhen ? String(s.doneWhen).trim() : '',
          target: s.target ? String(s.target).trim() : '',
        })).filter((s) => s.text),
      };
    }

    // completedStep lets a conversational reply also tick the checklist, so the
    // prose and the checklist cannot disagree about where the user is.
    const step = Number(parsed.completedStep);
    return {
      kind: 'answer',
      // `answerFrom` handles the one-step plan. A checklist of one is not a
      // checklist — PRODUCT.md — but the fall-through used `res.text`, so a
      // valid single-step task was shown to the user as the raw JSON blob the
      // model returned. It becomes an ordinary answer instead.
      markdown: answerFrom(parsed, res.text),
      // An ordinary answer can point at something too — see turn.js.
      target: targetFrom(parsed),
      completedStep: Number.isInteger(step) && step > 0 ? step - 1 : null,
    };
  }

  /**
   * Stream a plain answer. Used when there is no screenshot to wait on.
   *
   * NOTE: nothing calls this today — every turn goes through `respond()`. It is
   * kept because the no-screenshot path is a real product case, but it is
   * unreachable code and should be deleted if that stays true.
   *
   * `maxOutputTokens` and `signal` were both missing here, unlike every other
   * `_req` call: the answer silently inherited the 1400 default while
   * `prompts.js` documented a 3000 cap, and an in-flight answer could not be
   * aborted. Neither could reach a user, both were wrong.
   */
  async *stream({ prompt, history, signal }) {
    const parts = [];
    if (history && history.length) {
      const recent = history.slice(-4)
        .map((t) => `Q: ${t.prompt}\nA: ${(t.summary || '').slice(0, 300)}`)
        .join('\n\n');
      parts.push({ text: `Earlier in this conversation:\n${recent}\n\n---\n` });
    }
    parts.push({ text: prompt });

    const iterator = await this._client().models.generateContentStream(
      this._req(ANSWER_SYSTEM, parts, { temperature: 0.4, maxOutputTokens: 3000, signal })
    );
    for await (const chunk of iterator) {
      if (chunk && chunk.text) yield chunk.text;
    }
  }

  /**
   * Where is this control on screen?
   *
   * Normalised 0–1000 coordinates, never pixels — see src/main/geometry.js
   * for why that makes the whole DPI and multi-monitor problem disappear.
   *
   * The cap was 300, and that silently killed the arrow — the one thing this
   * product does that nothing else does.
   *
   * The reply itself is about 40 tokens. But a reasoning model spends the
   * budget THINKING before it emits anything, and working out where a control
   * sits in a 2880x1800 screenshot is exactly the kind of question it thinks
   * hard about. The budget ran out mid-answer and the text came back as
   *
   *     {"found":true,"label":"speaker icon","box_
   *
   * which `parseJson` correctly refuses, so `locate()` returned null and
   * `_pointAtTarget` treated it as "not found" and drew nothing. No error, no
   * log line, no arrow — the failure looked exactly like the model being unable
   * to find the control. Measured on google/gemini-3.5-flash: truncated at 300,
   * complete and correct at 2000.
   *
   * Raising the ceiling does not raise the cost. The model generates those
   * reasoning tokens either way and they are billed either way; all the low cap
   * bought was paying for them and throwing the answer away.
   */
  async locate({ screenshot, target, signal }) {
    const res = await this._client().models.generateContent(
      // 300 tokens used to be plenty: the reply is four numbers. It stopped
      // being plenty the moment the default model became a REASONING model,
      // because thinking tokens are charged against the same `max_tokens`
      // budget as the visible answer. The locator burned the whole 300 on
      // reasoning and returned empty text, so `parseJson` got null and the
      // arrow silently never drew — after a real 4-second call, with the
      // target correctly identified. Every other call site already asked for
      // 3000; this one alone was sized for a pre-reasoning model.
      //
      // Generous on purpose. A bounding box is a handful of tokens, so a high
      // ceiling costs nothing when the model is brief and is the difference
      // between working and not when it thinks first.
      this._req(LOCATE_SYSTEM, [imagePart(screenshot), { text: `Find: ${target}` }],
        { temperature: 0, maxOutputTokens: 2000, signal })
    );

    const parsed = parseJson(res.text);
    if (!parsed) {
      // Never fail silently here again. This is the last stage before the
      // arrow, and an unparseable reply is indistinguishable from "not found"
      // without seeing what actually came back.
      const raw = String(res.text || '');
      console.warn(
        `[locate] no JSON in the reply (${raw.length} chars): ${JSON.stringify(raw.slice(0, 200))}`,
      );
    }
    return parsed;
  }

  /**
   * Cheapest possible round trip, used to verify a key during setup.
   *
   * Uses the candidate key rather than the stored one, because at this point
   * nothing has been saved — the whole point is to find out whether saving it
   * is worthwhile.
   */
  async probe(candidateKey) {
    const client = new OpenRouterClient({ apiKey: String(candidateKey || '').trim() });
    await client.models.generateContent({
      model: this.getModel(),
      contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
      config: { temperature: 0, maxOutputTokens: 1 },
    });
    return true;
  }

  /**
   * Is the current step finished?
   *
   * Deliberately the cheapest call in the product: a downscaled frame and one
   * yes/no against a criterion written at plan time. It runs far more often
   * than anything else, so its cost sets whether watching is viable at all.
   *
   * The 200-token cap stays, and `llm.respond.test.js` enforces it.
   *
   * `locate` was raised to 2000 because a reasoning model truncated it
   * mid-JSON, and the same failure is theoretically possible here. It was
   * measured rather than assumed: on google/gemini-3.5-flash the verdict comes
   * back complete and correct at 200, because "is this step done" is a far
   * smaller question than "where is this control in a 2880x1800 screenshot".
   *
   * This call runs constantly while a task is being watched, so its cost is
   * what decides whether watching is affordable at all. It is not raised on
   * suspicion. If a heavier model ever does truncate here the symptom is
   * visible rather than silent — three unreadable verdicts stop the watch and
   * the checklist says so.
   */
  async checkStep({ screenshot, stepText, doneWhen, signal }) {
    const res = await this._client().models.generateContent(
      this._req(CHECK_SYSTEM, [
        imagePart(screenshot),
        { text: `Step: ${stepText}\nComplete when: ${doneWhen || stepText}` },
      ], { temperature: 0, maxOutputTokens: 200, signal })
    );
    return parseJson(res.text);
  }
}

module.exports = { Llm, parseJson, answerFrom, targetFrom };
