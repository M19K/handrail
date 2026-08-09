# Handrail — Project Context

> **Read this first.** This file is the handoff document. Any new session, thread,
> or agent picking up this project should be able to continue from here without
> re-deriving anything. Update it when a decision is made, not at the end.

Last updated: 2026-08-01

---

## ⏭ SESSION HANDOFF — read this first (2026-08-08)

### State: **v1 is built and it runs.**

The app boots, onboarding works, the overlay works, and the arrow draws on a
real screen. What remains is a live model test and packaging.

### Git state
Fresh repo, `main`. **Commit `7909792` is pristine upstream** — everything after
is original work. `git diff 7909792..HEAD` is the portfolio artifact.
Roughly **15,100 lines deleted, 1,900 written** in the rebuild.

### Verified by looking at pictures, not by assertion
| Command | What it proves |
|---|---|
| `npm test` | 24 unit tests — coordinate maths, provider detection. No Electron needed. |
| `npm run dev:renderer` | All 9 overlay states, against a mock bridge. PNGs in `%TEMP%\handrail-renderer`. |
| `npx electron scripts/smoke.js` | Real windows, real preload, real IPC. PNGs in `%TEMP%\handrail-smoke`. All checks pass. |
| `npm start` | Boots clean. |

### BLOCKED — one thing, and it is the same thing as always
**No live model call has ever been made.** Everything is verified structurally
and visually; the provider round trip is not. `.env` still has a 73-char value
on `GEMINI_API_KEY=` with `OPENROUTER_API_KEY=` empty — the key is on the wrong
line. Move it, then `npm start` and ask something real.

⚠ Check first whether that value is the key previously flagged as compromised.

### Next actions
1. **Move the key, run it, ask a real question.** Exercises the whole chain at
   once: capture → plan → arrow → watch → advance. Expect prompt tuning.
2. **Judge arrow accuracy on a real app.** The original go/no-go gate, still
   never answered with a funded key. Fallback if accuracy is poor: make
   pointing a setting that is off by default and let the checklist carry v1.
3. **App icons** — master is `design/brand/app-icon.svg`; generate with
   `electron-icon-builder` (command in `design/brand/README.md`).
4. **Package** — `npm run build:win`. macOS stays unsigned for v1.
5. **Polish pass** — `impeccable`, `emil-design-eng`, animation review.

### Known gaps, deliberate and worth knowing
- Thread switching lists and opens threads but does not re-render past turns
  into the panel. The store keeps them; the UI does not show them yet.
- The `Change` button on the API-key settings row is not wired to re-open
  onboarding.
- No tray icon. Once collapsed, the app is reachable only by hotkey
  (`Ctrl/Cmd+Shift+H`, panic-hide on `Ctrl/Cmd+Shift+Esc`).
- `src/core/logger.js` survives but nothing uses it — console only for now.

> ⚠ **Terminology.** The approved gstack artifact below is a **BUILD PLAN** —
> sequencing, architecture, risk order. It contains no pixels, no screens, no
> components. It was previously called "the design doc", which read as "the UI
> is designed". It is not. Visual design starts at `design/directions-v1.html`.

### Done
- Planning phase complete; **build plan APPROVED** at
  `~/.gstack/projects/TechyCSR-OpenCluely/m19k1-main-design-20260808-205158.md`
- **Visual direction chosen: A "Calm Instrument"** — mint `#2FD9A8`, dark
  translucent glass, floating. Board at `design/directions-v1.html`
- **Design system written** — `design/tokens.css`, three layers, no raw hex
  permitted in components
- **All v1 screens designed** — `design/screens-v1.html`: onboarding key entry,
  three overlay states, both answer types, arrow anatomy, both side panels
- **Logo chosen and built** — Mark C4 with the grip. Assets and usage rules in
  `design/brand/` (`mark.svg`, `mark-16.svg`, `mark-mono.svg`, `app-icon.svg`,
  `wordmark.svg`, `README.md`)
- **Step completion settled** — hybrid, weighted to watching. Full mechanism in
  `PRODUCT.md` § "Step completion"

### Design assets — where things live
```
design/tokens.css              the design system, three layers, no raw hex in components
design/brand/README.md         mark geometry, clear space, the grip variable, misuse
design/brand/*.svg             mark, 16px mark, mono, app icon, wordmark
design/screens-v1.html         every v1 screen at real size — build against this
design/directions-v1.html      the three-direction pitch (A chosen)
design/logo-v1.html            the four-mark pitch
design/logo-c-variations.html  the C revision that produced C4
```
- gstack + design skills installed (72 skills); superpowers plugin disabled
- `STEALTH_MODE` env flag added — set `false` to make the overlay screenshottable
- Prompt layer replaced: `prompts/guide.md` is now the only skill; dsa/programming
  deleted, multi-skill routing collapsed
- **Arrow spike harness built and its non-model half PROVEN** — see below

### Arrow spike — status (2026-08-08)

Everything except the model call is built and verified. `spike/arrow/` is a
standalone Electron app; it imports nothing from `main.js` or the four renderer
windows, so if the gate fails it is one `rm -rf` and nothing else unpicks.

```
spike/arrow/geometry.js       pure coordinate math — no Electron, no network
spike/arrow/geometry.test.js  17 tests, all passing, no API key needed
spike/arrow/vision.js         prompt + OpenRouter call + defensive JSON parse
spike/arrow/main.js           capture -> locate -> draw -> self-capture
spike/arrow/overlay.html      transparent click-through arrow renderer
```

```
npm test                                    # 17/17, no key required
npx electron spike/arrow --dry-run          # full draw path, no API call
npx electron spike/arrow -- "the Save button"   # needs the key
```

**PROVEN with no API key** (`--dry-run` writes evidence PNGs to
`%TEMP%\handrail-arrow-spike\`):
- Coordinate chain correct on a **1x** display and a **2x** display
- Correct on a display with a **negative origin** (this machine's second
  monitor sits at `(1920, −211)`)
- Multi-monitor source selection via `display_id`, verified on both screens
- Overlay covers the **full display including the taskbar strip**
- Transparent, click-through, always-on-top, draws legibly over other apps
- Self-capture evidence loop works

**STILL UNKNOWN — this is the actual gate:** whether the vision model returns a
box accurate enough to land an arrow on a real control. Needs the key.

### BLOCKED (narrowed)
Only the **model-accuracy half** of the spike is blocked. `.env` has a 73-char
value on `GEMINI_API_KEY=` and `OPENROUTER_API_KEY=` empty — the key is on the
wrong line. 73 chars = `sk-or-v1-` + 64 hex, i.e. the OpenRouter key.
Move it to `OPENROUTER_API_KEY=`, leave `GEMINI_API_KEY=` empty.
⚠ Check first whether that value is the key CONTEXT flagged as compromised
(line ~190); if so, rotate before use.

### Next actions, in order
**Re-sequenced 2026-08-08: design moved ahead of the spike.** The spike's
remaining half is blocked on the user's key; design is blocked on nothing, and
the project had produced nothing visible. Scheduling call, not a merits call.

1. ~~Pick a direction~~ **DONE — A.** ~~Design system~~ **DONE.** ~~Screens~~ **DONE.**
2. **Settle step completion** — the one open product question the mockups exposed.
   Does the user tick a step off, or does Handrail watch the screen and decide?
   Watching costs a screenshot and a model call per step; ticking is free but
   makes the user do bookkeeping. Argue this before building the renderer,
   because it changes the IPC contract and the step data model.
3. **Renderer rebuild — IN PROGRESS.**
   - ✅ IPC contract designed and written (`docs/IPC.md`)
   - ✅ `preload.js` rewritten — one bridge, one event stream
   - ✅ Overlay renderer built (`renderer/overlay.{html,css,js}`), all nine
     states verified by screenshot via `npm run dev:renderer`
   - ⬜ **NEXT: rewrite `src/managers/window.manager.js`** — one overlay window
     plus a one-time onboarding window, replacing four. Must handle
     `hr:window:resize` (renderer measures, main resizes) and keep
     `setContentProtection` behind `STEALTH_MODE`.
   - ⬜ Rewire `main.js` IPC handlers to the `hr:*` channels. Every old
     `electronAPI` channel is now dead — nothing calls them.
   - ⬜ Build the onboarding window against `design/screens-v1.html` § 01
   - ⬜ **Then delete:** `index.html`, `chat.html`, `llm-response.html`,
     `settings.html`, `onboarding.html`, `onboarding.js`, `src/ui/*`,
     `speech-recognition.js`, `src/services/speech.service.js`,
     `src/services/whisper-worker.service.js`, `src/core/whisper-installer.js`
     (~6.5k lines of renderer + ~2.9k of speech). Delete last, not first —
     they are the reference for anything main still needs.
4. **Arrow spike — model half only** (parked until the key lands). Then
   `npx electron spike/arrow -- "<control>"` over Premiere / Excel / a browser.
   Judge accuracy from `%TEMP%\handrail-arrow-spike\located.png`.
   Fallback if accuracy is bad: checklist becomes the headline instead.
4. **Finish the strip** — speech subsystem still threads through 16 files
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

### Watch out for — traps already paid for once
- **Order matters around `window-all-closed`.** Leaving zero windows open for an
  instant quits the app on Windows. Create the replacement, then close.
- **Hide Handrail's own windows before capturing** or the model reads its own
  previous answer back to the user. `src/main/turn.js:_captureWithoutSelf`.
- **`did-finish-load` can fire before you attach the listener** on local files.
  Check `isLoading()` first, or the wait deadlocks and looks like a hang.
- **`box-sizing: border-box` is not free.** Its absence made every padded
  element wider than its container by exactly its own padding.
- **Never let a flex item keep `min-width: auto`** if it must shrink — that is
  what pushed the bar 20px past the panel it shares an edge with.
- **Windows clamps a non-resizable window to the work area**, costing the
  taskbar strip. `setBounds()` after construction, then lock.
- **Old note, still true:** 51 tests from an earlier session live in a scratchpad
  and were never moved in. `npm test` now runs `spike/**` and `src/**`; widen it
  if they are ever recovered.
- **Two bugs found in `capture.service.js` during the spike**, both still present
  in the app and both fixed only inside `spike/arrow/main.js` so far:
  (a) it matches the capture source to a display by comparing thumbnail *sizes*,
  which picks the wrong monitor whenever two displays share an aspect ratio —
  match on `display_id` instead; (b) it requests `display.size` (DIP), so a 2x
  panel is captured at half resolution — request `size * scaleFactor`.
  Port both when the renderer is rebuilt.
- **Windows clamps a non-resizable window to the work area.** An overlay created
  at full display bounds silently loses the taskbar strip. Fix is `setBounds()`
  after construction, then `setResizable(false)`.
- Overlay label chips do not yet avoid each other when several targets are drawn
  at once. Irrelevant for v1 (one arrow), noted so it is not rediscovered.
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
- **Two displays, and the combination is a good test rig:**
  `[0] 1440x900 DIP @ scaleFactor 2 (2880x1800 native) at (1920, −211)`
  `[1] 1920x1080 DIP @ scaleFactor 1 at (0, 0)` — primary, has the taskbar
  Mixed DPI plus a negative origin covers the coordinate cases that break.
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
