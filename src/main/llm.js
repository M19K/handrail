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

class Llm {
  constructor(getKey, getModel) {
    this.getKey = getKey;
    this.getModel = getModel;
  }

  _client() {
    const key = this.getKey();
    if (!key) {
      const err = new Error('No API key set. Add one in Settings.');
      err.code = 'NO_KEY';
      throw err;
    }
    return new OpenRouterClient({ apiKey: key });
  }

  _req(system, parts, { temperature = 0.2, maxOutputTokens = 1400 } = {}) {
    return {
      model: this.getModel(),
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      config: { temperature, maxOutputTokens },
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
  async respond({ prompt, screenshot, history, activeTask }) {
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
      this._req(PLAN_SYSTEM, parts, { temperature: 0.3, maxOutputTokens: 3000 })
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
      markdown: String(parsed.markdown || parsed.answer || res.text || '').trim(),
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
  async locate({ screenshot, target }) {
    const res = await this._client().models.generateContent(
      this._req(LOCATE_SYSTEM, [imagePart(screenshot), { text: `Find: ${target}` }],
        { temperature: 0, maxOutputTokens: 300 })
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
  async checkStep({ screenshot, stepText, doneWhen }) {
    const res = await this._client().models.generateContent(
      this._req(CHECK_SYSTEM, [
        imagePart(screenshot),
        { text: `Step: ${stepText}\nComplete when: ${doneWhen || stepText}` },
      ], { temperature: 0, maxOutputTokens: 200 })
    );
    return parseJson(res.text);
  }
}

module.exports = { Llm, parseJson };
