/**
 * Arrow spike — the vision call.
 *
 * Sends one screenshot plus one natural-language target ("the Save button") to
 * the model and gets back a normalised bounding box. This is the entire
 * go/no-go question: can a vision model point at a real UI control accurately
 * enough that an arrow lands on it?
 *
 * Reuses the existing OpenRouter adapter rather than opening a second path to
 * the provider — if the adapter is wrong, the spike should fail for the same
 * reason the product would.
 */

const { OpenRouterClient } = require('../../src/services/openrouter.adapter');
const { NORM_MAX } = require('../../src/main/geometry');

/**
 * The prompt is deliberately blunt about the coordinate convention. Vision
 * models will happily return pixel coordinates, percentages, or 0..1 floats if
 * you leave it open, and every one of those silently produces a wrong arrow
 * rather than an error. Stating the space, the order, and the range explicitly
 * is the cheapest accuracy win available.
 */
const SYSTEM_PROMPT = `You locate user-interface controls in screenshots.

You will be given a screenshot of a computer screen and a description of a
control the user needs to interact with. Find that control and return its
bounding box.

COORDINATE SYSTEM — follow exactly:
- Coordinates are normalised to a 0-${NORM_MAX} grid over the whole image.
- 0 is the top/left edge, ${NORM_MAX} is the bottom/right edge.
- Report the box as [ymin, xmin, ymax, xmax]. Note that Y comes first.
- Do NOT report pixel coordinates. Do NOT use percentages or 0-1 floats.

Box the control ITSELF — the clickable button, menu item, field or icon — not
the panel or toolbar containing it. Tight bounds, not generous ones.

Respond with a single JSON object and nothing else. No prose, no markdown
fences.

If you find it:
{"found": true, "label": "<what you found, 2-5 words>", "box_2d": [ymin, xmin, ymax, xmax], "confidence": <0.0-1.0>, "instruction": "<one short sentence telling the user what to do>"}

If you cannot find it, or you are guessing:
{"found": false, "reason": "<why — not visible, ambiguous, wrong screen, etc>"}

Returning found:false is correct and useful. A confident wrong box is worse
than an honest miss, because the user will be pointed at the wrong thing.`;

/**
 * Strip the wrapping models add despite being told not to, then parse.
 *
 * Order matters: try the raw string first (the well-behaved case), then a
 * fenced block, then the outermost brace pair. Anything left is a genuine
 * failure worth surfacing with the raw text attached for diagnosis.
 */
function parseModelJson(text) {
  if (!text || !text.trim()) {
    return { ok: false, error: 'model returned empty text' };
  }

  const candidates = [];
  const trimmed = text.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return { ok: true, value: parsed };
    } catch (_) {
      // try the next candidate
    }
  }

  return { ok: false, error: 'could not parse JSON from model output', raw: trimmed };
}

/**
 * Ask the model where `target` is in `imageBuffer`.
 *
 * Returns { ok, value?, error?, raw?, elapsedMs, model } where `value` is the
 * model's own JSON, unmodified. Interpreting it is geometry.js's job — keeping
 * the network layer free of coordinate logic means the coordinate logic stays
 * testable without a key.
 */
async function locateControl({ apiKey, model, imageBuffer, mimeType = 'image/png', target }) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  if (!imageBuffer || !imageBuffer.length) throw new Error('no image to send');
  if (!target || !target.trim()) throw new Error('no target described');

  const client = new OpenRouterClient({ apiKey });
  const startedAt = Date.now();

  const response = await client.models.generateContent({
    model,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
          { text: `Find: ${target.trim()}` },
        ],
      },
    ],
    // Zero temperature: this is a measurement, and run-to-run variance would
    // make it impossible to tell a prompt improvement from noise.
    config: { temperature: 0, maxOutputTokens: 512 },
  });

  const elapsedMs = Date.now() - startedAt;
  const parsed = parseModelJson(response && response.text);

  return { ...parsed, elapsedMs, model, usage: response && response.usageMetadata };
}

module.exports = { locateControl, parseModelJson, SYSTEM_PROMPT };
