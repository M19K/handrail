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
function answerFrom(parsed, raw) {
  const written = String(parsed.markdown || parsed.answer || '').trim();
  if (written) return written;

  if (parsed.kind === 'task' && Array.isArray(parsed.steps)) {
    const steps = parsed.steps
      .map((s) => String((s && s.text) || '').trim())
      .filter(Boolean);
    if (steps.length) {
      const title = String(parsed.title || '').trim();
      // One step is a sentence, not a list. More than one only reaches here if
      // every other step was blank, in which case a list is still right.
      const body = steps.length === 1 ? steps[0] : steps.map((t) => `- ${t}`).join('\n');
      return title && steps.length > 1 ? `**${title}**\n\n${body}` : body;
    }
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

class Llm {
  /**
   * @param {() => string|null} getKey
   * @param {() => string} getModel
   * @param {(opts: {apiKey: string}) => object} [makeClient] how to build the
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
      const err = new Error('No API key set. Add one in Settings.');
      err.code = 'NO_KEY';
      throw err;
    }
    return this.makeClient({ apiKey: key });
  }

  /**
   * `signal` is threaded all the way to fetch. Without it, cancelling a slow
   * vision call left the request running and billed — only the reply was
   * discarded — so Escape looked like a cancel and was not one.
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

  /** Stream a plain answer. Used when there is no screenshot to wait on. */
  async *stream({ prompt, history }) {
    const parts = [];
    if (history && history.length) {
      const recent = history.slice(-4)
        .map((t) => `Q: ${t.prompt}\nA: ${(t.summary || '').slice(0, 300)}`)
        .join('\n\n');
      parts.push({ text: `Earlier in this conversation:\n${recent}\n\n---\n` });
    }
    parts.push({ text: prompt });

    const iterator = await this._client().models.generateContentStream(
      this._req(ANSWER_SYSTEM, parts, { temperature: 0.4 })
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
   */
  async locate({ screenshot, target, signal }) {
    const res = await this._client().models.generateContent(
      this._req(LOCATE_SYSTEM, [imagePart(screenshot), { text: `Find: ${target}` }],
        { temperature: 0, maxOutputTokens: 300, signal })
    );
    return parseJson(res.text);
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

module.exports = { Llm, parseJson, answerFrom };
