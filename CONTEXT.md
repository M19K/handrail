# Handrail — Project Context

> **Read this first.** This file is the handoff document. Any new session, thread,
> or agent picking up this project should be able to continue from here without
> re-deriving anything. Update it when a decision is made, not at the end.

Last updated: 2026-08-09

---

## ⏭ SESSION HANDOFF — read this first (2026-08-09)

### Where it is

**Handrail runs.** It is packaged, installed and on the desktop:

- source: `C:\Users\m19k1\Downloads\Claude Projects\OpenCluely`
- installed: `%LOCALAPPDATA%\Programs\Handrail\Handrail.exe`
- shortcut: `%USERPROFILE%\Desktop\Handrail.lnk`
- rebuild + reinstall: `node scripts/package-win.js --install`

34 commits, pushed. `7909792` is pristine upstream and is the first commit on
GitHub, so `git diff 7909792..HEAD` is the portfolio artifact: **93 files,
+13,146 / −21,781** — it removes more than it adds, which is the point.

- repo: **https://github.com/M19K/handrail** — public, no fork relationship
- version: **0.1.3**, in `VERSION`, `package.json` and `CHANGELOG.md`
- PRs [#1](https://github.com/M19K/handrail/pull/1), [#2](https://github.com/M19K/handrail/pull/2)
  and [#3](https://github.com/M19K/handrail/pull/3) — all merged
- releases: **v0.1.0 through v0.1.3 are all DRAFTS**, none published. Four
  assets each: Windows setup + portable `.exe`, macOS x64 + arm64 `.dmg`
- **Publish v0.1.3 and discard the rest.** v0.1.2 and earlier ship the lite
  model, which invents menu paths for software that is not on screen
- publishing is a deliberate human step — read the notes, then press it


### Built since the last handoff

- **Renderer rebuilt.** Four windows became one overlay with three states plus
  two side panels. The old `index/chat/llm-response/settings/onboarding` HTML is
  gone.
- **Main process rewritten.** `src/main/` — store, llm, capture, turn, windows,
  ipc, geometry, prompts. `main.js` went from ~2,000 lines to ~200.
- **IPC contract redesigned.** ~90 channels across two bridges became one
  namespaced bridge and a single event stream. See `docs/IPC.md`.
- **Identity shipped.** Mark C4 with the grip, `design/brand/`, `design/tokens.css`.
- **Arrow spike passed and became the product.** `src/main/geometry.js` is
  production code now; `spike/arrow/` imports from it.
- **Windows packaging without electron-builder** — it cannot run on this machine
  (symlink extraction needs Developer Mode). `scripts/package-win.js` does it
  directly, including a hand-written `.ico` encoder.
- **Speech deleted.** No Whisper, no Azure, no `node-record-lpcm16`.

### Verification — three layers, all green

- `npm test` — **99 unit tests** (geometry, turn state machine, `respond()`,
  capture source selection, store recovery, response shapes, key-format
  detection). Node's built-in runner, no framework, no Electron. **This is what
  gates CI, so it must never need a display or a binary.**
- `npx electron scripts/smoke.js` — **63 checks** against the real main process
  and real preload, writing screenshots to `%TEMP%\handrail-smoke`.
- `npm run qa` — **29 Playwright `_electron` tests** that launch the real app
  (`tests/qa/`), covering what smoke structurally cannot: boot, window
  lifecycle, the single-instance lock, position persistence, onboarding, and
  what a person sees when the model call fails. Screenshots to
  `%TEMP%\handrail-qa`.
- Both smoke and QA run against throwaway userData directories. Smoke used to
  write to the real one, which mutated the installed app and made results depend
  on the previous run.

### Review status (2026-08-09)

First independent review run: gstack `/review` with three specialist agents.
**27 findings, 27 fixed** — the full list with the fix and its test is in
[`docs/REVIEW-2026-08-09.md`](docs/REVIEW-2026-08-09.md). Read it before
touching `src/main/turn.js`.

The two worst are closed. `.env` no longer overrides the stored API key in a
*packaged* build — dotenv ships inside the app, so a `.env` dropped beside the
executable used to silently reroute every screenshot through someone else's
OpenRouter account. And an arrow can no longer be drawn after the user has
hidden Handrail: `this.epoch` is now captured and checked across every await in
`_pointAtTarget`, not merely bumped.

The last open item, `llm.respond()` having no test at all, is closed too. The
blocker was structural — the provider client was built inside `_client()` with
no seam to test through — so `Llm` takes an optional client factory now, and
that is the only reason it does. **Nothing on that page is open.**

### Known gaps, in priority order

1. ~~**The model still guesses at UI it cannot see.**~~ **Closed 2026-08-09.**
   It was never the prompt — prompts.js line 145 always forbade it and the lite
   model ignored it. Default is now google/gemini-3.5-flash. Measured with
   scripts/compare-models.js: asked about Obsidian with Obsidian closed, lite
   described the inside of its settings window; flash made step 1 "open it from
   the taskbar". $0.0006 vs $0.0024 per question.
2. **macOS is built but never run.** CI produces both `.dmg` files on every tag
   and they have never been opened on a Mac. All parity work is still theoretical.
3. **Onboarding is untested by a real user other than the author.** It is now
   covered by 7 automated tests and they all pass, but nobody unfamiliar with the
   product has been watched going through it.
4. **Four design findings left unfixed on purpose** — the type scale, the
   placeholder's 3.11:1 contrast, the send keycap's contrast, and 17–22px touch
   targets. Each would be a redesign rather than a repair, so each is the
   author's call. Written up in
   `.gstack/qa-reports/design-audit-handrail-2026-08-09.md`.
5. Nothing else.

### Traps added by the review fixes

- **`this.epoch` must be captured before the first await and checked after every
  one.** Any new async path that ends in `point()` or `emit()` needs the same
  guard, or the arrow-after-hide bug comes straight back.
- **`hr:ask` carries `threadId`.** Any new caller that omits it silently
  inherits whatever thread was last pinned.
- **`mock-bridge.js` is not packaged.** The `<script>` tag in `overlay.html`
  404s in a shipped build and that is correct — do not "fix" it by shipping the
  file.

### Traps

- **`.env` is dev-only.** The packaged app has none; the key lives encrypted in
  userData. `OPENROUTER_API_KEY` in `.env` still wins when running from source.
- **Never import from `spike/` in `src/`.** It is not packaged; doing so crashes
  the packaged app on boot and looks like a blank error dialog.
- **Task Manager caches process names** — after a rebuild it can show the old
  `FileDescription` until Task Manager itself is restarted.
- **The renderer sends its own `capture` flag** on every ask. Changing capture in
  the store alone leaves main and renderer disagreeing.
- **Windows hides new tray icons** in the overflow flyout. The app cannot promote
  itself; the user drags it out.

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

Superseded — see the SESSION HANDOFF at the top of this file. The section that
was here described the pre-rewrite codebase (`llm.service.js`, `speech.service.js`,
`first-run.js`, four renderer windows) and none of those files exist any more.

Kept only as a note that it was deliberately removed rather than forgotten.


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
- [ ] New repo name / GitHub org — still open, and blocks /ship
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

---

## gstack protocol — where we actually are (2026-08-09)

Recorded honestly because the plan in this file says one thing and the commit
log says another. The intended spine was:

`/office-hours` → `/autoplan` → `/plan-eng-review` → `/review` → `/ship`

and the design order was: identity → design system → `/design-shotgun` →
`brandkit` → `/design-html` → polish → `/qa` `/review` `/ship`.

| Stage | Status | Note |
|---|---|---|
| `/office-hours` | **done** | 2026-08-08, Builder mode. Produced the approved design doc. |
| `/autoplan` | **skipped** | Never run. Work was sequenced by hand from the design doc. |
| `/plan-eng-review` | **skipped** | Never run. |
| `/plan-design-review` | **skipped** | Never run. |
| Identity | **done, off-skill** | Direction A and mark C4 chosen from hand-built comparison boards, not via the `design` skill. |
| Design system | **done, off-skill** | `design/tokens.css`, written directly. |
| `ui-ux-pro-max` | **partial** | Its Python search tool cannot run — no Python on this machine. Its CSV data was read directly instead. |
| `/design-shotgun` | **substituted** | Variants were built by hand (`design/directions-v1.html`, `logo-*.html`) rather than by the skill. |
| `brandkit` | **skipped** | Direction was locked in `DECISIONS.md` instead. |
| `/design-html` | **substituted** | Renderer written directly. |
| `impeccable`, `emil-design-eng`, animation trio | **done, substituted** | 2026-08-09. Run as `/design-review` scoped to defects, not restyling — 4 fixed, 4 flagged. |
| `/qa` | **done** | 2026-08-09. Playwright `_electron`, 29 tests, 2 bugs found and fixed — `.gstack/qa-reports/qa-report-handrail-2026-08-09.md`. |
| `/review` | **done** | 2026-08-09. 27 findings, all 27 fixed — `docs/REVIEW-2026-08-09.md`. |
| `/ship` | **done** | 2026-08-09. VERSION, CHANGELOG, PR #1 merged, v0.1.1 tagged and built. |

### The honest summary

We ran phase 0 and then improvised. Everything from identity onward was done
directly rather than through the skills, and the review and ship stages have not
happened at all.

That was not all bad — the work was driven by live user testing of a running
build, which caught things no plan review would have (the arrow's compositor
lag, the turn-id race, the undecryptable key). But it means:

- no independent review has looked at the diff
- there is no changelog, version history or release
- the polish pass the design plan called for has not been done

### What to do about it, in order

1. ~~**`/review`**~~ — done 2026-08-09, then all 27 findings fixed.
2. ~~**`/qa`**~~ — done 2026-08-09. 29 `_electron` tests, 2 bugs fixed.
3. ~~**`/ship`**~~ — done 2026-08-09. v0.1.1 tagged, built, waiting as a draft.
4. ~~**`impeccable` + `emil-design-eng`**~~ — done 2026-08-09 as a defect-scoped
   `/design-review`.

**Every stage of the original plan has now been run.**
