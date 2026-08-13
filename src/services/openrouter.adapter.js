/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
/**
 * OpenRouter adapter.
 *
 * Handrail speaks Google Gemini's native protocol throughout. This module
 * presents the same surface as `new GoogleGenAI({apiKey})` — an object with
 * `.models.generateContent()` and `.models.generateContentStream()` — but
 * talks OpenAI-compatible JSON to OpenRouter underneath and converts the
 * responses back into Gemini-shaped objects.
 *
 * That means llm.service.js's existing extractors keep working untouched:
 *   - extractTextFromCandidates() reads `response.text` first
 *   - _extractChunkText() reads `chunk.text` first
 *
 * Activated only when OPENROUTER_API_KEY is set. If it is absent the app
 * falls back to the stock Gemini path, so this patch is non-destructive.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Gemini model ids -> OpenRouter model ids.
 * Anything not listed passes through unchanged, so you can put a raw
 * OpenRouter id (e.g. "anthropic/claude-sonnet-4.5") in config and it works.
 */
const MODEL_MAP = {
  'gemini-3.5-flash': 'google/gemini-2.5-flash',
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gemini-2.5-pro': 'google/gemini-2.5-pro',
  'gemini-2.0-flash': 'google/gemini-2.0-flash-001',
  'gemini-1.5-flash': 'google/gemini-flash-1.5',
  'gemini-1.5-pro': 'google/gemini-pro-1.5',
};

function mapModel(name) {
  if (process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;
  if (!name) return 'google/gemini-2.5-flash';
  if (MODEL_MAP[name]) return MODEL_MAP[name];
  if (name.includes('/')) return name; // already an OpenRouter id
  return 'google/gemini-2.5-flash';
}

/** Gemini `parts[]` -> OpenAI message content (string, or array for vision). */
function convertParts(parts) {
  if (!Array.isArray(parts)) return '';

  const out = [];
  let textOnly = true;

  for (const part of parts) {
    if (!part) continue;

    if (typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
      continue;
    }

    // Gemini inline image -> OpenAI data-URI image_url
    const inline = part.inlineData || part.inline_data;
    if (inline && inline.data) {
      textOnly = false;
      const mime = inline.mimeType || inline.mime_type || 'image/png';
      out.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${inline.data}` },
      });
    }
  }

  // Collapse to a plain string when there is no media — smaller payloads and
  // better compatibility with models that reject the array form.
  if (textOnly) return out.map((p) => p.text || '').join('');
  return out;
}

/** Full Gemini request -> OpenAI chat-completions body. */
function geminiToOpenAI(request, modelName, stream, web) {
  const messages = [];

  const sys = request.systemInstruction;
  if (sys) {
    const text = Array.isArray(sys.parts)
      ? sys.parts.map((p) => (p && p.text) || '').join('\n')
      : typeof sys === 'string'
        ? sys
        : '';
    if (text.trim()) messages.push({ role: 'system', content: text });
  }

  for (const item of request.contents || []) {
    if (!item) continue;
    messages.push({
      role: item.role === 'model' ? 'assistant' : 'user',
      content: convertParts(item.parts),
    });
  }

  const gen = request.generationConfig || request.config || {};
  const body = {
    model: mapModel(modelName),
    messages,
    stream: !!stream,
  };

  // OpenRouter's web plugin. Preferred over the `:online` model suffix because
  // it is configurable and leaves the model id intact — the id is also what the
  // key-ownership and model-comparison paths read, and rewriting it there would
  // make a web-enabled turn look like a different model entirely.
  if (web) body.plugins = [{ id: 'web', max_results: 3 }];

  if (typeof gen.temperature === 'number') body.temperature = gen.temperature;
  if (typeof gen.topP === 'number') body.top_p = gen.topP;
  if (typeof gen.maxOutputTokens === 'number') body.max_tokens = gen.maxOutputTokens;
  // topK and thinkingConfig have no OpenAI equivalent — intentionally dropped.

  return body;
}

/** OpenAI completion -> Gemini-shaped response object. */
function toGeminiResponse(json) {
  const choice = (json && json.choices && json.choices[0]) || {};
  const text = (choice.message && choice.message.content) || '';
  return {
    text,
    candidates: [
      {
        content: { parts: [{ text }], role: 'model' },
        finishReason: choice.finish_reason || 'STOP',
      },
    ],
    usageMetadata: json && json.usage ? json.usage : undefined,
  };
}

/** One OpenAI stream delta -> Gemini-shaped chunk. */
function toGeminiChunk(json) {
  const choice = (json && json.choices && json.choices[0]) || {};
  const text = (choice.delta && choice.delta.content) || '';
  return {
    text,
    candidates: [
      {
        content: { parts: [{ text }], role: 'model' },
        finishReason: choice.finish_reason || null,
      },
    ],
  };
}

/**
 * OpenRouter reads `HTTP-Referer` and `X-Title` to attribute traffic on its
 * public app leaderboard, so these are not cosmetic — they must name Handrail.
 * They carried upstream's values until 0.1.5; see DECISIONS.md 2026-08-10.
 */
function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/M19K/handrail',
    'X-Title': 'Handrail',
  };
}

/**
 * Surface OpenRouter failures with wording llm.service.js's analyzeError()
 * already recognises, so its retry/fallback logic keeps working.
 */
async function raiseHttpError(res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      detail = JSON.parse(body)?.error?.message || body;
    } catch (_) {
      detail = body;
    }
  } catch (_) {
    detail = res.statusText;
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Invalid API key or insufficient permissions (${res.status}): ${detail}`);
  }
  if (res.status === 429) {
    throw new Error(`Rate limit exceeded (429): ${detail}`);
  }
  if (res.status >= 500) {
    throw new Error(`OpenRouter server error (${res.status}): ${detail}`);
  }
  throw new Error(`OpenRouter request failed (${res.status}): ${detail}`);
}

/** Status codes worth trying again. Everything else is the caller's fault. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Attempts, including the first. Three total, so two retries. */
const MAX_ATTEMPTS = 3;

/**
 * How long to wait before attempt `n`, honouring Retry-After when given.
 *
 * Exported for tests: the delays are the whole behaviour, and a retry ladder
 * that silently waits the wrong amount is indistinguishable from one that
 * works until a demo.
 */
function retryDelayMs(attempt, retryAfterHeader) {
  const stated = Number(retryAfterHeader);
  // Cap a hostile or absurd Retry-After — a provider asking for five minutes
  // mid-demo is not something to obey silently.
  if (Number.isFinite(stated) && stated > 0) return Math.min(stated * 1000, 8000);
  return Math.min(500 * 2 ** (attempt - 1), 4000);   // 500ms, 1s, 2s…
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST with retries.
 *
 * WHY THIS EXISTS: there was no retry at all. A single 429 or a one-off 503
 * went straight to the user as a red "Try again" button, and during a live
 * demo on 2026-08-10 that happened three or four times in a row. Every one of
 * those was a transient provider hiccup that a 500ms wait would have absorbed.
 *
 * Deliberately narrow: only idempotent transport failures and the status codes
 * above are retried. A 401 is not a hiccup and retrying it just makes the user
 * wait longer for the same answer. An aborted request is never retried —
 * Escape means stop, and retrying it would resurrect a call the user killed.
 */
async function postWithRetry(url, init, signal) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) return res;

      const wait = retryDelayMs(attempt, res.headers && res.headers.get('retry-after'));
      console.warn(`[openrouter] ${res.status} — retrying in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(wait);
    } catch (err) {
      // The user pressed Escape. Not a failure to paper over.
      if (err && (err.name === 'AbortError' || (signal && signal.aborted))) throw err;
      if (attempt === MAX_ATTEMPTS) throw err;

      lastError = err;
      const wait = retryDelayMs(attempt);
      console.warn(`[openrouter] ${err.message} — retrying in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(wait);
    }
  }

  throw lastError;
}

class OpenRouterModels {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async generateContent({ model, contents, config: genConfig, systemInstruction, signal, web }) {
    const body = geminiToOpenAI(
      { contents, generationConfig: genConfig, systemInstruction },
      model,
      false,
      web
    );

    const res = await postWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: headers(this.apiKey),
      body: JSON.stringify(body),
      // Passed through so Escape actually aborts the request on the wire. A
      // cancelled 3000-token vision call used to keep running and stay billed;
      // only the reply was thrown away.
      signal,
    }, signal);

    if (!res.ok) await raiseHttpError(res);
    return toGeminiResponse(await res.json());
  }

  async generateContentStream({ model, contents, config: genConfig, systemInstruction, signal }) {
    const body = geminiToOpenAI(
      { contents, generationConfig: genConfig, systemInstruction },
      model,
      true
    );

    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: headers(this.apiKey),
      body: JSON.stringify(body),
      // Passed through so Escape actually aborts the request on the wire. A
      // cancelled 3000-token vision call used to keep running and stay billed;
      // only the reply was thrown away.
      signal,
    });

    if (!res.ok) await raiseHttpError(res);
    if (!res.body) throw new Error('Empty streamed response from OpenRouter');

    // Async generator yielding Gemini-shaped chunks, matching the
    // @google/genai streaming contract the caller expects.
    return (async function* () {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            yield toGeminiChunk(JSON.parse(payload));
          } catch (_) {
            // OpenRouter sends periodic ": OPENROUTER PROCESSING" comments
            // and occasional partial frames — skip anything unparseable.
          }
        }
      }
    })();
  }
}

class OpenRouterClient {
  constructor({ apiKey }) {
    if (!apiKey) throw new Error('OpenRouter API key is required');
    this.apiKey = apiKey;
    this.models = new OpenRouterModels(apiKey);
  }
}

/**
 * `OpenRouterClient` is the whole public surface.
 *
 * The rest — `geminiToOpenAI`, `toGeminiResponse`, `toGeminiChunk`, `mapModel`,
 * `OPENROUTER_BASE` — are used inside this file and were exported to nobody;
 * `transcribeAudio` went with them, along with the speech-to-text it served.
 * v1 cut speech entirely (see CONTEXT.md § v1 scope), so it had been dead since
 * that decision.
 *
 * `headers()` was NOT dead, which is easy to misread from the above: it feeds
 * both live calls, so its attribution headers went out on every real request.
 * Corrected in 0.1.5.
 */
module.exports = {
  retryDelayMs, OpenRouterClient };
