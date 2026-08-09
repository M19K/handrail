# OpenCluely — OpenRouter deployment notes

Patched build. Runs from source, routes all LLM traffic through OpenRouter.

## What was changed

| File | Change |
|---|---|
| `src/services/openrouter.adapter.js` | **New.** Drop-in replacement for `GoogleGenAI` — same `.models.generateContent()` / `.generateContentStream()` surface, speaks OpenAI format to OpenRouter, returns Gemini-shaped responses. |
| `src/services/llm.service.js` | `initializeClient()` prefers OpenRouter when `OPENROUTER_API_KEY` is set; `_streamRequestForModel()` delegates to the adapter; `executeAlternativeRequest()` short-circuits (its raw-HTTPS fallback targets Google); model-fallback lists mapped to OpenRouter ids. |
| `package.json` | Added `start:win` / `dev:win` — the stock `start` uses POSIX `env -u`, which fails in PowerShell. |
| `.env` | Created. Holds your OpenRouter key and model choice. |

The patch is **non-destructive**: clear `OPENROUTER_API_KEY` and the app reverts
to the stock Gemini path. Verified by test.

## Start it

1. Put your OpenRouter key in `.env`:
   ```
   OPENROUTER_API_KEY=sk-or-v1-...
   ```
2. Run:
   ```
   npm run start:win
   ```

Change models by editing `OPENROUTER_MODEL` in `.env`. Any OpenRouter id works
(`google/gemini-2.5-flash`, `anthropic/claude-sonnet-4.5`, `openai/gpt-4o`).
Use a vision-capable model or screenshot/OCR features will fail.

## Verification performed

**51 tests passing.**

- **26/26** adapter translation tests — request conversion (text + vision +
  `inline_data` variant), response and stream-chunk conversion, parameter
  mapping, model-id mapping, and compatibility with the two extractor
  functions in `llm.service.js`.
- **12/12** LLM wiring tests — OpenRouter mode activates, correct client class,
  model resolution, request builders convert cleanly, and Gemini fallback
  still works when the key is absent.
- **13/13** speech tests — transcription contract (empty buffer, missing key,
  oversize rejection), provider resolution, availability without a Whisper CLI,
  auto-detection, and fallback to local Whisper when no key is present.
- `node --check` clean on all modified/added files.

Not yet verified: live calls against OpenRouter (both LLM and STT need a real
key), and the overlay's capture-exclusion behaviour.

## Speech-to-text (OpenRouter)

Also wired. `SPEECH_PROVIDER=openrouter` uses the same key as the LLM.

The existing local-Whisper capture pipeline is reused wholesale — VAD,
segmentation, WAV encoding, hallucination filtering, event emission. Only the
final "buffer -> text" step is swapped, in `_transcribeWhisperBuffer()`. No
Python, ffmpeg, or model download required.

| Setting | Value |
|---|---|
| `SPEECH_PROVIDER` | `openrouter` |
| `OPENROUTER_STT_MODEL` | `openai/whisper-1` (default) |

Provider auto-detection prefers OpenRouter when a key is present, then Azure,
then local Whisper. Set `SPEECH_PROVIDER` explicitly to override.

Endpoint limits are enforced client-side before upload: 25 MB max, 60s timeout.
The VAD segments at ~4s, so neither is reachable in normal use.

Cost is roughly **$0.36/hour** of transcribed audio. Audio leaves your machine —
if that matters, switch `SPEECH_PROVIDER` to `whisper` and install the Python
toolchain instead.

## Known gaps

**`topK` and `thinkingConfig` are dropped** in translation — no OpenAI
equivalent. Behaviour is unaffected for normal use.

**Certificate verification is weakened for one host.** `main.js:324-330`
overrides cert checking with `callback(0)` for
`generativelanguage.googleapis.com`. Unused in OpenRouter mode but still
present in the code.

**Upstream updates will conflict.** This is a fork of an actively developed
app. `git pull` will likely conflict in `llm.service.js`. The adapter file
itself is standalone and should survive.

## If you prefer the prebuilt binary

`~/Downloads/OpenCluely-Setup-1.8.7.exe` was downloaded and its SHA256
**verified against the project's published `SHA256SUMS.txt`**. It is unsigned,
so SmartScreen will warn. Note it is the **stock** build — Gemini only, no
OpenRouter patch. Use it only if you'd rather supply a Gemini key from
aistudio.google.com than run from source.
