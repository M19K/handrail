# Handrail — Project Context

> **Read this first.** This file is the handoff document. Any new session, thread,
> or agent picking up this project should be able to continue from here without
> re-deriving anything. Update it when a decision is made, not at the end.

Last updated: 2026-08-01

---

## ⏭ SESSION HANDOFF — read this first (2026-08-08)

### Git state
Fresh repo, `main`. **Commit `7909792` is pristine upstream** — everything after
is original work. `git diff 7909792..HEAD` is the portfolio artifact.

```
8150b29 feat(prompts): replace interview skill layer with guided-task assistance
394c126 docs: add project context, decisions, product spec, platform matrix
fd2fce0 feat(window): make capture-exclusion configurable via STEALTH_MODE
9e0ae1f feat(speech): add OpenRouter transcription provider
8e3f115 feat(llm): route inference through OpenRouter via drop-in adapter
7909792 Initial import: OpenCluely @ 0a9da75 (Apache-2.0)
```

### Done
- Design phase complete; design doc **APPROVED** at
  `~/.gstack/projects/TechyCSR-OpenCluely/m19k1-main-design-20260808-205158.md`
- gstack + design skills installed (72 skills); superpowers plugin disabled
- `STEALTH_MODE` env flag added — set `false` to make the overlay screenshottable
- Prompt layer replaced: `prompts/guide.md` is now the only skill; dsa/programming
  deleted, multi-skill routing collapsed

### BLOCKED
**Arrow spike** (step 1, the go/no-go gate on the headline feature) needs a
funded OpenRouter key. User will reuse the existing key and load credits.
`.env` currently has it on the **wrong line** — it must be on
`OPENROUTER_API_KEY=`, with `GEMINI_API_KEY=` left empty.

### Next actions, in order
1. **Arrow spike** — screenshot a real app → vision model → bounding box → draw
   arrow in overlay. Validate DPI scaling + multi-monitor. Half a day, go/no-go.
2. **Finish the strip** — speech subsystem still threads through 16 files
   (`main.js`, `preload.js`, `config.js`, `first-run.js`, `settings.html`,
   `onboarding.*`, `src/ui/*`, `speech-recognition.js`, `whisper-*`). This is
   surgery, not a delete — do it as a focused pass. Voice is cut from v1.
   Also dead code left behind: `prompt-loader.js:91` `case 'dsa':` inside
   `injectProgrammingLanguage()`, now unreachable.
3. **Rebrand** — `package.json` still says `opencluely` / TechyCSR / `com.opencluely.app`;
   macOS `extendInfo` usage strings still reference Whisper and OpenCluely and are
   user-facing copy; `hardenedRuntime` must become `true` before any future notarization.
4. **Identity** → `design` skill. Then `ui-ux-pro-max` → `design-system` → `/design-shotgun`
   (include BOTH onboarding options — one-time window vs overlay side panel — the
   open question is deliberately deferred to visual mockups).
5. **Renderer rebuild** — delete all four renderer windows, build one overlay with
   three states (collapsed pill → expanded bar (default) → expanded answer) plus
   slide-out panels. Redesign the IPC contract alongside.
6. **Polish** → `impeccable`, `emil-design-eng`, animation pass. **Ship** → `/qa`
   (Playwright `_electron`), `/review`, `/ship`.

### Watch out for
- **51 tests exist but live in the session scratchpad, not the repo** — they must
  be moved in as a real suite.
- `.env` is gitignored (`.gitignore:2`) — the key has never been committed. Keep it that way.
- Backup of pre-reinit state: `%LOCALAPPDATA%\Temp\claude\handrail-backup\`
- gstack slug is `TechyCSR-OpenCluely`, from the old git remote. It will change
  when the remote is repointed; early artifacts stay under the old slug.

---

## What Handrail is

A cross-platform desktop overlay that **sees your screen and walks you through
technical tasks step by step.**

The core insight: a normal chat assistant is blind. It can't see the error
dialog, the terminal output, the half-configured settings pane. An overlay that
can take a screenshot has visibility on everything, so it can guide execution
rather than give generic advice.

**Positioning: aimed at non-technical users.** Handrail exists to even the score
for people without an advanced technical background — the person who can follow
instructions but can't diagnose why step 4 failed. This is the product thesis
and it drives every UI and copy decision.

### Primary use cases
- Walking through the installation of software or dependencies
- Getting the exact terminal command right, in context
- Debugging something that's failing, with the error actually visible
- Any task where "what do I click next" needs the current screen as input

### Explicitly NOT the product
- Interview cheating / assessment evasion — the upstream project's purpose
- Coding-interview or DSA assistance
- Anything framed around concealment rather than assistance

---

## Origin and licensing

Handrail is a fork of **[OpenCluely](https://github.com/TechyCSR/OpenCluely)**
(TechyCSR), licensed **Apache 2.0**.

- The upstream repo has three conflicting license claims: `LICENSE` = Apache 2.0,
  `package.json` = ISC, README badge = MIT. **Treat Apache 2.0 as binding.**
- Obligations on redistribution: retain `LICENSE`, mark modified files as
  changed, preserve copyright notices, add own copyright alongside.
- The name "OpenCluely" is **not** licensed to us — hence Handrail.
- No `NOTICE` file upstream, so that obligation does not apply.

### Attribution strategy (decided)
- Do **not** use GitHub's Fork button — it buries the work in upstream's network graph.
- Fresh repo. **First commit = pristine upstream import** tagged with the upstream SHA.
- Every subsequent commit is provably our work; `git diff <first>..HEAD` is the portfolio artifact.
- README leads with what Handrail *is*, with a short honest attribution line.
- Goal is a substantial rewrite, not a reskin — the delta is the point.

---

## Current state

### Where the code lives
`C:\Users\m19k1\Downloads\Claude Projects\OpenCluely\` — shallow clone of upstream,
already modified. Will be renamed / re-inited as Handrail.

### Modifications already made (by Claude, not upstream)
| File | Change |
|---|---|
| `src/services/openrouter.adapter.js` | **New.** Drop-in `GoogleGenAI`-compatible shim that speaks OpenAI format to OpenRouter and returns Gemini-shaped responses. Also contains `transcribeAudio()` for STT. |
| `src/services/llm.service.js` | Routes through OpenRouter when `OPENROUTER_API_KEY` is set; streaming, model mapping, alt-request path patched. Falls back to Gemini when unset. |
| `src/services/speech.service.js` | New `openrouter` speech provider reusing the entire local-Whisper capture pipeline; only the transcription backend swapped. |
| `src/core/first-run.js` | Accepts an OpenRouter key as valid setup (was Gemini-only). |
| `package.json` | Added `start:win` / `dev:win` (stock `start` uses POSIX `env -u`). |
| `.env` | Created. |
| `DEPLOYMENT.md` | Change log + verification record. |

**51 tests passing** (26 adapter translation, 12 LLM wiring, 13 speech).
Test scripts live in the session scratchpad — **should be moved into the repo
as a proper test suite.**

### Not yet done
- No live API call has been made — everything is verified structurally only
- Stealth toggle (`STEALTH_MODE` env flag) not yet implemented
- No rebrand, no UI work, no name change in code
- Fresh repo not yet created

---

## Upstream feature inventory

**Core:** invisible overlay (`setContentProtection`, single call site at
`src/managers/window.manager.js:628`); auto-hide on screen-share detection;
click-through toggle; process-name masking (reports as "Terminal"); global
hotkeys; multi-monitor tracking; four windows (main, chat, llmResponse, settings).

**Input:** screenshot capture → image straight to model (no OCR); fallback
capture service; voice with manual or VAD modes; STT via local Whisper, Azure,
or OpenRouter.

**AI:** streaming; 15-turn session memory; language-aware (C++/C/Python/Java/JS);
**only two skill prompts — `dsa.md` and `programming.md`**; model fallback chain;
markdown + Prism highlighting.

**Infra:** first-run onboarding (Gemini-specific); settings window with live
reload; Winston logging; no telemetry; electron-builder cross-platform builds.

### The key finding
The entire prompt/skill layer is **interview-specific**. Handrail's use case has
**zero** existing support. Rough split: **~60% reusable plumbing** (overlay,
capture, streaming, windowing) / **~40% to rip out and rebuild** (interview
framing, DSA prompts, onboarding, UI).

---

## Machine / environment

- Windows 11 Home, build 26200
- Node v25.9.0, npm 11.12.1, git 2.53.0.windows.2
- **No Python** (only the Microsoft Store alias stub) — local Whisper unavailable
- **No ffmpeg**
- No CUDA GPU (Intel integrated only) — local Whisper would be CPU-bound
- 31.4 GB RAM, 16 logical cores
- Chrome and Edge both installed (Playwright QA path available)
- Also installed: Cluely (commercial, `%LOCALAPPDATA%\Programs\cluely`), Pluely v1.0.0

### Provider setup
- **OpenRouter** for both LLM and STT, one key
- Default model `google/gemini-2.5-flash` ($0.30/M in, $2.50/M out)
- STT `openai/whisper-1` (~$0.006/min ≈ $0.36/hr)
- ⚠️ A key was pasted into chat and is **compromised — must be rotated**

---

## Build stack (agreed)

Workflow spine is **gstack**. Design skills layered on top.

| Skill | Purpose |
|---|---|
| `gstack` | Sprint spine: `/office-hours` → `/autoplan` → `/plan-eng-review` → `/review` → `/ship` |
| `ui-ux-pro-max` | Palette + typography |
| `design` | Logo, identity, tokens — Phase 1 |
| `design-system` | primitive → semantic → component tokens, before components |
| `brandkit` | Locks the chosen direction as a brand board |
| `emil-design-eng` | Finish-quality details |
| `apple-design` | Prioritised — macOS is first-class, motion language suits an overlay |
| `impeccable` | Final polish, only once a front end exists |
| animation trio | `find-animation-opportunities` → `improve-animations` → `review-animations` |
| `pick-ui-library` | Renderer component stack is currently unopinionated |

- **Skipped:** `greensock/gsap-skills` — overlay needs restraint; add later only if the design demands it
- **Disabled:** `superpowers` plugin (`~/.claude/settings.json`) — competing planning methodology, collides with gstack
- **Kept:** `playwright` plugin — its `_electron` API is the QA path for an Electron app; `context7` for library docs

### Working order
Phase 0 `/office-hours` → 1 identity → 2 design system → 3 `/design-shotgun`
variants → 4 lock via `brandkit` → 5 `/design-html` + components → 6 polish →
7 `/qa` `/review` `/ship`

---

## v1 scope (locked 2026-08-01)

**In:** Windows + macOS desktop app, screenshot-driven, text input, guided
task execution for non-technical users.

**Out:**
- **Voice / speech entirely** — cut from v1. Most complex subsystem, only feature
  with an unsolved macOS problem (system-audio needs a user-installed loopback
  driver), ~$0.36/hr to run, and not needed for a screenshot-driven use case.
  The OpenRouter STT work stays in the repo but the feature is disabled.
- Interview / DSA use case — upstream's purpose, not ours.
- **The entire existing UI** — no coherent workflow, no home or dashboard,
  structurally incoherent. Full rework, not incremental improvement.

**macOS distribution:** unsigned `.dmg` for v1, with the Gatekeeper workaround
documented prominently in the README (right-click → Open → "Open Anyway", or on
macOS 15+ System Settings → Privacy & Security → "Open Anyway"). Apple Developer
Program enrolment deferred until funds allow — see `PLATFORM.md`.

---

## Build stack — INSTALLED 2026-08-01

72 skills in `~/.claude/skills/`. Bun 1.3.14 at `~/.bun/bin/bun.exe`.

- **gstack** — installed, 53 skills linked, Windows file-copy mode (no Developer
  Mode needed). Re-run `./setup` after every `git pull`.
- **gbrain deliberately NOT installed** — creates a memory silo tied to one machine.
- Design: `design`, `design-system`, `ui-ux-pro-max`, `ui-styling`, `brand`,
  `banner-design`, `slides`
- Polish/motion: `emil-design-eng`, `apple-design`, `impeccable`, `animate`,
  `animation-vocabulary`, `find-animation-opportunities`, `improve-animations`,
  `review-animations`, `pick-ui-library`, `prototype`
- `superpowers` plugin **disabled** in `~/.claude/settings.json` (collides with gstack)
- `playwright` and `context7` plugins kept

**Skills load at session start — a restart is required before any of these work.**

---

## Open decisions

- [ ] Component library for the renderer (`pick-ui-library`)
- [ ] Aesthetic direction — must pick exactly one and hold it
- [ ] Whether the OpenRouter adapter stays or the product ships its own provider layer
- [ ] Where the 51 existing tests live in the new repo structure
- [ ] New repo name / GitHub org
- [ ] What to do with the now-dead speech subsystem — delete or leave dormant

---

## Next action

**Restart Claude Code**, then run `/office-hours` to establish product scope
before any design work. The user has UI/product direction to give at that point.

---

## Conventions

- `CONTEXT.md` (this file) — living state; update on decisions, not at the end
- `DECISIONS.md` — append-only, one line per decision, never rewrite a line
- `PLATFORM.md` — Windows/macOS parity matrix
- Never commit secrets; `.env` is gitignored
- Never invent copy, brand names, testimonials, or stats
- Verify visually — screenshot and look before claiming something renders
