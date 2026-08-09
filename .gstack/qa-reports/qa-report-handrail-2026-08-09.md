# QA report — Handrail, 2026-08-09

**Target:** the packaged desktop app, driven through `electron .` — not a URL.
**Method:** Playwright `_electron`, 29 tests across four suites, each launch on a
throwaway userData directory.
**Tier:** Standard (fix critical + high + medium).
**Run it:** `npm run qa`

| | Before | After |
|---|---|---|
| QA tests | 0 | 29 |
| Passing | — | 29 |
| Issues found | — | 2 |
| Fixed | — | 2 |
| Deferred | — | 0 |
| Health score | 78 | 96 |

---

## Why this is not a browser QA run

Handrail is an Electron desktop overlay. There is no server, no URL and no page
to navigate to. The equivalent of "open the app and click things" is Playwright's
`_electron` API, which launches the real binary and drives the real windows —
which is what `CONTEXT.md` planned for and what the `playwright` plugin was kept
for.

**What this adds over `scripts/smoke.js`.** Smoke constructs `Store`, `Windows`
and `TurnController` by hand inside one Electron process and pushes synthetic
events at the renderer. It proves the functions work. It never boots the app, so
it cannot see anything that only happens on the way in or on the way out: the
boot decision, window lifecycle, the single-instance lock, position persistence,
the tray, the global shortcuts, or what a person sees when the model call fails.
Both suites are kept; they cover different halves.

**`playwright-core`, not `playwright`.** Driving Electron needs `_electron` and
nothing else. The full package downloads three browsers on install, which would
then have to be downloaded in CI too, for nothing.

---

## Issues found

### QA-001 — Launching Handrail again hides it — **high**, fixed

**Category:** functional
**Where:** `main.js`, `app.on('second-instance')`
**Commit:** `714087f`

`second-instance` called `toggleOverlay()`. So double-clicking the desktop
shortcut while the overlay was already on screen made it disappear. The icon the
user clicked to summon the app is the thing that dismissed it, with nothing on
screen to explain that — and the natural next move is to double-click again,
which brings it back, so it reads as the app flickering at random.

**Repro:** open Handrail, leave it visible, double-click the desktop shortcut.
**Was:** the overlay vanishes.
**Now:** it stays, is focused, and falls back to onboarding when there is no key.

Toggling is right for the tray icon and the hotkey — those are switches.
Launching is not a switch.

**Test:** `tests/qa/interaction.test.js` → "launching Handrail again shows it —
it never hides it".

### QA-002 — The overlay's position was silently lost — **medium**, fixed

**Category:** functional
**Where:** `src/main/windows.js`, `createOverlay`
**Commit:** `ad12cbc`

Position persistence listened to `moved` only. That fires once at the end of a
hand drag and for nothing else — a window moved by `setBounds`, by the OS
reflowing after a display change, or by a snap never fired it, so the position
was dropped and the overlay came back centred on the next launch. On a two-monitor
machine that is the difference between the overlay returning where you left it
and returning on the other screen.

**Repro:** move the overlay by any means other than dragging it, quit, relaunch.
**Was:** back at the default centre position; `settings.json` has no `overlayPos`.
**Now:** the position is written.

Fixed by also listening to `move`, debounced 400ms. The debounce is the point:
`move` fires continuously during a drag, and writing `settings.json`
synchronously on every mouse tick would make dragging the overlay stutter.

**Test:** `tests/qa/boot.test.js` → "window position survives a restart".

---

## What was tested and found clean

**Boot (7 tests).** No key opens onboarding and does not build the overlay early;
a key opens the overlay and skips onboarding; the overlay is sandboxed,
context-isolated, node-free and always-on-top; the preload bridge exposes every
channel `docs/IPC.md` promises and nothing named `key`, `apiKey` or `screenshot`;
a second launch loses the single-instance lock and exits; the store writes to
userData and nowhere else.

**Onboarding (7 tests).** This was listed in `CONTEXT.md` as never having been
tested by anyone but the author. It came back clean: three steps, forward and
back both work, the key field is `type="password"`, Continue stays disabled for
empty and for nonsense, a pasted key with stray whitespace still detects,
provider detection reads "OpenRouter" from the key shape, a rejected key leaves
the user on the key step with a reason, and no form of the key comes back over
the bridge.

**Interaction (9 tests).** Typing and Enter alone sends a question and clears the
field; a dead key produces "That API key was rejected. Check it in Settings."
with a Try again button rather than a spinner that never stops; Escape closes the
panel first and only then collapses; the collapsed pill clicks back open; every
Settings switch reaches the store; the threads panel lists, searches and filters;
two questions fired on top of each other do not leave the bar stuck; the quit
button quits.

**Overlay (6 tests).** The question field has focus the moment Handrail opens;
every bar control has an accessible name and a reachable tab stop; the window
grows with a long answer but stays inside the work area; the stealth toggle
changes the real window's content protection immediately rather than on restart;
the renderer cannot be navigated off its own file.

---

## Not covered, and honest about it

- **The arrow window is only covered by `scripts/smoke.js`.** Driving it through
  a full app launch needs a live model call to produce a target.
- **No real model calls.** Every launch uses a well-formed dead key, so the
  happy path past `respond()` is not exercised here. That is deliberate: a QA
  run that spends money is a QA run nobody runs.
- **macOS is untested.** These tests are platform-neutral and should run there,
  but nobody has run them on a Mac.
- **`llm.respond()` still has no unit test** — carried over from the review.

## PR summary

> QA found 2 issues, fixed 2, added 29 `_electron` tests. Health 78 → 96.
