# Changelog

All notable changes to Handrail are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.2] — 2026-08-09

The polish pass, which was the last unrun stage of the original plan, plus the
last open item from the review.

### Fixed

- **Every piece of text now clears WCAG AA.** `--text-tertiary` measured 4.37:1
  against the base surface, just under the 4.5:1 threshold. It carries every
  settings row's explanation, the API key hint and the panel headings — the only
  description a user gets of what each toggle does, for an audience defined as
  people who are not technical. Now 4.66:1, and invisibly different to the eye.
- **Two font sizes were off the type scale.** The step number (9px) and the
  threads list date headings (9.5px) both sat below the smallest token. Both are
  `--text-micro` now.
- **The empty threads list read as a category heading.** It reused the uppercase
  micro label that heads "Today" and "This week", so it appeared as a heading for
  a group that was not there and said nothing about what to do next. It is a
  sentence now, and it names the next action.
- **The pointing smoke checks raced about one run in four.** The capture toggle
  is clicked through the UI on purpose, but the async settings round trip was
  never waited for, so the question was sometimes sent with capture off — no
  screenshot, no pointing, and a failure that read as the feature being broken.

### Added

- **`llm.respond()` has tests.** It was the one load-bearing function in the
  product with none, and it survived both the review and the QA pass because the
  provider client was built inside `_client()` with no seam to test through.
  `Llm` takes an optional client factory now. 19 tests over the request going out
  and the result coming back. Unit tests: 80 → 99.
- A design audit report at
  `.gstack/qa-reports/design-audit-handrail-2026-08-09.md`, including four
  findings deliberately left alone because fixing them would be a redesign rather
  than a repair: the type scale, the placeholder's contrast, the send keycap's
  contrast, and touch target sizes.

### Notes

`docs/REVIEW-2026-08-09.md` now has nothing open. Verification stands at 99 unit
tests, 63 smoke checks and 29 QA tests.

---

## [0.1.1] — 2026-08-09

First QA pass. Handrail was driven as a real application for the first time —
launched through `electron .` with Playwright's `_electron`, rather than
assembled in-process by the smoke test — and two bugs only that view could find
were fixed.

### Fixed

- **Launching Handrail again no longer hides it.** `second-instance` called
  `toggleOverlay()`, so double-clicking the desktop shortcut while the overlay
  was already on screen made it disappear — the icon you clicked to summon the
  app is what dismissed it. Toggling is right for the tray icon and the hotkey;
  launching is not a switch. ([`714087f`](../../commit/714087f))
- **The overlay's position stopped being lost.** Persistence listened to `moved`,
  which fires only at the end of a hand drag. A window moved by any other means —
  a display change, a snap, a programmatic move — had its position silently
  dropped and came back centred. Now also listens to `move`, debounced 400ms so
  dragging does not stutter. ([`ad12cbc`](../../commit/ad12cbc))

### Added

- **29 QA tests** driving the real app (`npm run qa`), in four suites: boot,
  onboarding, interaction and overlay. They cover what `scripts/smoke.js`
  structurally cannot — the boot decision, window lifecycle, the single-instance
  lock, position persistence, and what a person sees when the model call fails.
- `playwright-core` as a dev dependency. `_electron` is all that is needed, and
  the full package downloads three browsers that CI would download again.

### Notes

`npm test` deliberately stays pure and Electron-free: it gates the release in CI
and must not need a display. `npm run qa` is the Electron suite.

---

## [0.1.0] — 2026-08-09

First release. A desktop overlay that sees your screen and walks you through
software step by step, aimed at people who can follow an instruction but cannot
diagnose why step 4 failed.

Handrail is a fork of [OpenCluely](https://github.com/TechyCSR/OpenCluely)
(Apache-2.0) that keeps its transparent always-on-top overlay and replaces
essentially everything else. Commit `7909792` is the pristine upstream import;
`git diff 7909792..HEAD` is 93 files, +13,146 / −21,781.

### Added

- **Guided tasks.** Ask a question with the screen visible and get either a
  direct answer or a checklist that advances itself.
- **On-screen pointing.** An arrow drawn at the real control on the real screen,
  in its own small window, with normalised 0–1000 coordinates so mixed-DPI and
  multi-monitor setups work.
- **Step watching.** The checklist advances by looking at the screen, gated by a
  free local frame diff, a quiet debounce and a rate cap, so a user who is
  reading and not touching anything costs nothing.
- **One overlay with three states** — collapsed pill, bar, answer — plus threads
  and settings panels, replacing four separate windows.
- **Onboarding** in three steps: what Handrail does, an API key, screen
  permission. One key field and no provider dropdown; the provider is worked out
  from the key's shape.
- **Encrypted key storage** via the OS keychain, with an honest plaintext
  fallback that announces itself.
- **Windows and macOS installers**, built in CI and attached to a GitHub Release.

### Changed

- **Main process rewritten.** `main.js` went from ~2,000 lines to ~200; the rest
  is `src/main/{store,llm,capture,turn,windows,ipc,geometry,prompts}.js`.
- **IPC redesigned.** ~90 channels across two preload bridges became one
  namespaced bridge and a single event stream. See `docs/IPC.md`.
- **Inference routed through OpenRouter** by a drop-in adapter.

### Removed

- **The interview and DSA use case**, which was upstream's purpose and is
  explicitly not Handrail's.
- **The entire speech subsystem** — Whisper, Azure, `node-record-lpcm16`. It was
  the most complex part of the product, the only one with an unsolved macOS
  problem, and not needed by anything screenshot-driven.
- The four old renderer windows and their HTML.

### Security

- The overlay renderer runs sandboxed. It shipped with `sandbox: false` — the one
  window rendering model output was the one outside Chromium's sandbox.
- `openExternal` takes a destination name from a fixed map, not a URL.
- `.env` no longer overrides the stored key in a packaged build. dotenv ships
  inside the app, so a `.env` dropped beside the executable used to silently
  reroute every screenshot through someone else's OpenRouter account.
- `hr:setup:*` verifies the sender is the onboarding window, so the overlay
  cannot overwrite the user's key.
- Model output never reaches `innerHTML`; the key never crosses the bridge after
  setup; screenshots never cross it at all.

### Fixed

All 27 findings from the first independent review
([`docs/REVIEW-2026-08-09.md`](docs/REVIEW-2026-08-09.md)), including an arrow
that could be drawn after the user had hidden Handrail, and follow-up questions
being written to the wrong conversation.

### Known limitations

- Unsigned on both platforms. Windows SmartScreen and macOS Gatekeeper will warn
  on first run; the steps are in the README and the release notes.
- The macOS build has not been opened by anyone on a Mac.
- The model still guesses at UI it cannot see, and can give a confidently wrong
  menu path.
- `llm.respond()` has no unit test.

[0.1.2]: https://github.com/M19K/handrail/releases/tag/v0.1.2
[0.1.1]: https://github.com/M19K/handrail/releases/tag/v0.1.1
[0.1.0]: https://github.com/M19K/handrail/releases/tag/v0.1.0
