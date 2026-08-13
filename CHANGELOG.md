# Changelog

All notable changes to Handrail are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.9] — 2026-08-10

Five features and the two faults reported from live use.

### Fixed

- **The overlay flickered for everyone watching a screen share.** With "Hide
  from screen sharing" deliberately switched OFF, Handrail blinked out and back
  on for a colleague on Google Meet, several times a minute, while the local
  screen looked perfectly static.

  Handrail hid itself from its own screenshot by turning macOS content
  protection ON immediately before each capture and OFF immediately after.
  Content protection is also exactly what removes a window from a screen share,
  and it does not affect the local display — which is the whole signature of
  what was seen. Self-exclusion now paints Handrail's own rectangles out of the
  captured pixels instead. Nothing toggles, the user's stealth setting is the
  only thing that touches content protection, and it works the same on both
  platforms.

- **"Try again" during a live demo, three or four times.** There was no retry
  anywhere. A single 429 or a one-off 503 went straight to the user as a red
  error. Requests now retry twice with backoff, honour `Retry-After` (capped, so
  a provider cannot park a demo for five minutes), and never retry an abort —
  Escape still means stop.

### Added

- **Attachments on a thread.** Attach a document or an image with the paperclip
  and it stays available to every question in that thread, not just the next
  one. The bytes never cross into the renderer, the same rule screenshots
  follow. Five files per thread, 5MB each.
- **Web search, off by default.** The globe in the bar lets a question be
  answered from the web when the answer is not on screen. Off unless asked for,
  because the README promises your screen and conversations stay on your
  machine and a lookup sends the question to a search provider. Replies say
  which part came from the web.
- **Collapse and re-open a conversation in one click.** The X on the panel was a
  chevron-shaped lie: it hid the transcript and the only way back was through
  the Threads panel to re-select a thread that had never closed. Up collapses to
  the bar, down brings the same thread straight back.
- **A copy button under every reply.** Copies the plain text, not the markup.

### Changed

- **The answer is roughly ten times smaller on the wire.** The question pass now
  captures at 1600px as JPEG rather than full native resolution as PNG — about
  1MB down to about 100KB, and four times better again on a Retina display.
  Locating a control still captures at native resolution in PNG, because that is
  the pass where fine detail decides whether the arrow lands on a 16px icon.

---

## [0.1.7] — 2026-08-10

**The arrow was not working.** On the default model it had stopped being drawn
at all, and nothing said so — not an error, not a log line, not a test.

### Fixed

- **The arrow is back.** When Handrail asked the AI *where* a control was on
  screen, it gave it a budget too small to answer in. Newer models think before
  they reply, and the thinking used up the whole budget, so the answer arrived
  cut in half and unreadable. Handrail treated that as "I couldn't find it" and
  quietly drew nothing. Pointing at things on your screen is the entire point of
  this product, so this was as bad as it gets.
- It failed silently, which is why it survived: every test passed, no error was
  shown, and it looked exactly like the AI being unable to find the thing.

### Verified

For the first time, the whole chain was tested for real on Windows: a genuine
question, a real screenshot of the desktop, a real answer from the AI, and the
arrow drawn on screen landing on the actual control it named — photographed, on
a high-resolution display. Every earlier claim that the arrow worked was based
on made-up coordinates in a test, never a real one.

### Known

- Step-watching still uses a small budget on purpose. It was measured and works,
  and it is the part that runs constantly, so making it bigger would make
  watching more expensive for no gain.

---

## [0.1.6] — 2026-08-10

**The Windows build had no tray icon, and never had a working panic key.** Both
shipped in every release since 0.1.0. Found by downloading the released
installer and running it — the one thing none of the test suites do.

### Fixed

- **No tray icon on Windows.** The packaged app could not find its own tray
  artwork, so it ran with no system-tray presence at all. Because the overlay
  stays out of the taskbar, that left no way to quit it once it was hidden.
  Every build made during development had a tray, which is exactly why nobody
  caught it — only the released one was broken.
- **The panic hotkey did nothing on Windows.** It was Ctrl+Shift+Esc, which
  Windows keeps for Task Manager and will not hand to any app. It is now
  **Ctrl+Alt+H**. That is the shortcut that hides Handrail instantly when it is
  on a screen you are sharing, so it mattered that it silently did not exist.
- Together those two were the bad case: the overlay on a shared screen, no
  shortcut to hide it, and no tray icon to quit from.

### Added

- A check that launches the real packaged app and fails the build if it cannot
  start or has no tray icon. It was proved by deliberately breaking the build
  and confirming it fails. It now runs on every release, for both platforms.
- `npm run doctor` works on Windows: it reports duplicate installations,
  leftover build output, shortcuts pointing at the wrong copy, and whether
  Smart App Control will block the app. It previously did nothing there.

### Known

- **Windows 11 Smart App Control can refuse to open Handrail outright**, with no
  "Run anyway" to click. Use the `Handrail-Setup` installer rather than the
  portable build if you hit it. Only code signing fixes this properly, and that
  is a paid certificate this project does not have.
- The tray icon was confirmed from the app's own log rather than photographed —
  a fullscreen app was covering the taskbar at the time.

---

## [0.1.5] — 2026-08-10

**A reply that promised a list and delivered nothing.** Found in a live demo,
not by a test — every suite was green while it happened.

### Fixed

- **Half of an answer was being thrown away.** The model can return a reply
  carrying both an opening sentence and a list of steps. Handrail returned the
  sentence and silently discarded the steps, so a reply that ended *"here's the
  full path:"* showed the lead-in, the colon, and nothing else — and no arrow,
  because the step that named the on-screen control went into the bin with the
  rest. Nothing was truncated and nothing timed out; the complete answer arrived
  and was cut in half on the way to the screen.

  Reproduced from: *"how do I route my internet through my other computer?"*
  asked over Tailscale's Exit Nodes pane.

- **Three copies of Handrail were launchable at once, and Spotlight offered all
  three.** A rebuild leaves `dist/mac/Handrail.app` and
  `dist/mac-arm64/Handrail.app` on disk. Searching "Handrail" in Finder returned
  those alongside the installed app with nothing to distinguish them, and each
  carries its own ad-hoc signature under the same bundle id — so launching the
  wrong one runs an app the Screen Recording grant does not cover, and Handrail
  reports it cannot see the screen while System Settings shows the toggle on.

  `build:mac` now deletes the unpacked bundles once the build is verified, and
  `npm run doctor` FAILS on any extra bundle rather than noting it. The old
  check only warned when a bundle was registered with LaunchServices, which
  missed the way people actually open apps: Spotlight indexes anything on disk.

- **Clicking the tray icon during onboarding opened the overlay anyway.** The
  tray and hotkeys are registered before the key is read, deliberately, so a
  boot failure cannot leave the app unreachable. But nothing on those paths
  checked whether setup was finished, so clicking the new menu bar icon put a
  ready overlay bar on screen on top of the setup window — one app showing two
  windows, which reads exactly like two copies running at once. The relaunch
  path already had this guard; the tray and hotkey paths did not.

- **The prompt had no shape for what it was asking for.** The reply rules ask
  for "a lead plus a list", and the JSON schema offered no object that could
  hold one — the checklist shape has no lead-in field. The schema now says a
  lead-in plus a list is the answer shape, forbids ending on a colon, and states
  that the prose and bullet ceilings are separate budgets, so running short on
  sentences is never a reason to stop before the list.

- **Shape is now chosen by the work, not the wording.** "How do I route my
  internet through my other computer?" reads like one action and is five.

- **OpenRouter traffic was attributed to another project.** `HTTP-Referer` and
  `X-Title` still carried upstream's repo and name on every live call, and
  OpenRouter uses both for its public app leaderboard.

- `Llm.stream()` passed neither an output ceiling nor an abort signal, unlike
  every other request in the file. It is unreachable code — nothing calls it —
  so neither defect could reach a user, but both were wrong.

### Added

- `src/main/llm.scenarios.test.js` — the reply-quality layer. Real user
  questions through the real reply path, asserting what a person would notice: a
  reply is never empty, never raw JSON, and never promises a list it does not
  deliver. The failure above passes every other suite in this repo and fails
  this one.
- CI now runs `verify:mac` on the packaged macOS build before a release is cut.

### Changed

- Upstream association reduced to what Apache 2.0 requires. Four unmodified
  upstream files and one misspelled upstream asset folder were unreferenced dead
  weight and were removed rather than edited.
- The README no longer quotes a diff stat that went stale on every commit.

### Known limits

- Unchanged from 0.1.4: unsigned on both platforms, and never run on a Retina
  display, a mixed-DPI multi-monitor setup, or Intel x64.

---

## [0.1.4] — 2026-08-10

**macOS ran for the first time.** Every release since 0.1.0 built a `.dmg` in CI
that nobody had ever opened. On 2026-08-09 one was opened on a Mac mini M4
running macOS 26.5.2, and it did not work — not "had rough edges", could not be
installed and did not draw a window. This release is that build being made real.

Running from source was already fine, and all three suites passed on macOS
unmodified. Everything below is the gap between "the source runs" and "the thing
a person downloads works".

### Fixed

- **The `.dmg` could not be installed at all.** Gatekeeper rejected it with
  *"Handrail is damaged and can't be opened"*, offering only **Move to Trash**.
  Right-click → Open showed the same dialog, and no "Open Anyway" row appeared
  in Privacy & Security — that row is only offered for the unverified-developer
  verdict. The only way past it was `xattr -cr` in Terminal.

  The bundle was not unsigned, it was **malformed**: `codesign` reported
  `Signature=adhoc`, `linker-signed`, `Sealed Resources=none`,
  `Identifier=Electron`. electron-builder had never signed it; what shipped was
  the linker's stub, which seals none of the bundle's resources.

  `scripts/afterpack-mac.js` now signs the bundle ad-hoc, inside-out, and
  **fails the build** if the result does not verify. The verdict becomes "Apple
  could not verify…", which clears in two documented clicks. Costs nothing and
  needs no Apple account. Developer ID + notarisation is still the only way to
  get a clean double-click.

- **The app launched and then did nothing.** A live process, no window, no menu
  bar icon, no hotkey, no log, no crash report. Force Quit was the only way out.

  Two independent causes, either of which alone was fatal:

  1. **ASAR integrity.** electron-builder 26 writes an `ElectronAsarIntegrity`
     header hash into `Info.plist`; Electron 29 validated it differently and
     rejected a **correct** hash — recomputing SHA-256 over the asar header
     matched `Info.plist` exactly, and the app still refused to boot, exiting
     inside dyld before a line of JavaScript ran. Fixed by moving to a current
     Electron rather than by switching the check off.

  2. **The keychain.** `safeStorage.decryptString()` blocked the main process
     forever. On macOS the secret's ACL is bound to the app's **code
     signature**, and an ad-hoc signature changes every build — so every update
     presents a key the running binary does not own. macOS answers with an
     authorisation prompt, and `LSUIElement` means there is no window at boot
     for it to attach to. `decryptString` is synchronous, so main stopped there,
     before the overlay, the tray and the hotkey existed.

     Reproduced against the shipped build: with `key.dat` present the app was
     windowless; with it moved aside the same binary booted straight into
     onboarding.

- **The packaged app had no menu bar icon.** `build.files` shipped neither
  `assets/` nor `build/`, so none of the three paths `main.js` looks for existed
  inside the `.app` and it fell through to "no tray icon on disk". With
  `LSUIElement` also removing the Dock icon, the shipped app had **no visible
  presence anywhere in the system** — nothing to click, and nothing to quit.
  Windows was unaffected because `scripts/package-win.js` copies the artwork
  explicitly, which is why it survived four releases.

- **The menu bar icon was a solid blob.** `setTemplateImage(true)` was called on
  the full app icon — a dark rounded square that is 98% opaque. macOS keeps only
  the alpha channel of a template image, so the "silhouette" was a filled
  rectangle and the mark was invisible. `scripts/make-tray-icons.js` now draws
  the mark as alpha only at 16px and `@2x`.

- **"Your saved key could not be read" showed on every first run, on every
  platform.** `.notice { display: flex }` outranks the `hidden` attribute, which
  is styled by the UA sheet — so the warning was never actually hidden. First-time
  Mac users were told their key had been lost by *"Windows regenerating its
  encryption store"*. `overlay.css` had carried the `[hidden]` guard since it was
  written; `onboarding.html` was the one file that did not.

- **Onboarding reported screen access as granted when it was not.** The check was
  `sources.length > 0`, and on macOS `desktopCapturer.getSources()` returns a
  source whether or not permission exists. So setup always completed, and the
  failure surfaced later as a raw `Failed to get sources.` in the middle of the
  user's first real question, above a **Try again** button that could never
  succeed — macOS binds screen-recording access when the process launches, so a
  permission granted mid-session does nothing until the app restarts.

  `systemPreferences.getMediaAccessStatus('screen')` is the authority now.
  Onboarding says what is wrong, opens the exact Privacy & Security pane, and
  offers a **Restart Handrail** button.

- **The app icon rendered as coloured static in System Settings.** Handrail's row
  in Privacy & Security showed a block of noise beside its name, while the Dock
  and Finder looked correct. electron-builder's generated `.icns` puts the small
  sizes in the `icp4`/`icp5`/`icp6` chunk types, which may hold either PNG or raw
  pixels and carry no discriminator — macOS 26 reads them as raw. Extracting the
  chunk produced a perfectly good 16px PNG: the artwork was never wrong, the
  container was. `scripts/make-icons.js` now builds `build/icon.icns` with
  Apple's `iconutil`, which emits the types every macOS agrees on, and a test
  fails if the ambiguous ones come back.

- **The keychain guard was one build too coarse.** Fingerprinting a build as
  `app-<version>` correctly separated a dev run from a packaged one and one
  release from the next, but not two builds of the *same* version — and an
  ad-hoc signature is unique per build, not per version. A rebuilt 0.1.4 reading
  a key saved by an earlier 0.1.4 believed it was the owner, called into the
  Keychain and produced the password prompt the guard exists to prevent.
  `scripts/beforepack-build-id.js` now stamps a unique id into every packaged
  build. Caught live during verification, not by a test.

- **The build claimed microphone and camera access it never uses.** Electron's
  placeholder strings ("This app needs access to the microphone") shipped in the
  packaged `Info.plist` for features v1 cut. Deleted at build time.

### Added

- **A log file.** `<userData>/handrail.log`, truncated per run, with the previous
  run kept beside it. `console.log` in a packaged mac app goes nowhere a user can
  reach, which is why the failures above took a day to find instead of a minute.

- **`npm run verify:mac`** — launches the **built bundle** and fails if it cannot
  get far enough to write one line of its own log. It is the only check in the
  repo that runs the packaged app; `npm test`, smoke and the Playwright suite all
  run against the repo, where every one of these defects is invisible. Wired into
  `npm run build:mac`.

- Tests for the two failures a green suite could not see: keychain ownership
  (`src/main/store.keyowner.test.js`) and packaging invariants
  (`src/main/packaging.test.js`) — the tray artwork exists, is mostly
  transparent, and is listed in `build.files`.

- **`npm run doctor`** (`scripts/doctor-mac.js`) — the macOS environment check,
  and the only layer that looks outside the repo. It exists because an evening
  went to a failure the other four could not see. Three copies of `Handrail.app`
  were on one Mac at once — the installed one plus both `dist/` build outputs,
  the latter registered simply by `verify:mac` launching them — each ad-hoc
  signed differently while all three claimed `com.handrail.app`. macOS keys a
  Screen Recording grant to the **code signature**, so the permission the user
  granted kept applying to a bundle that was not the one asking:
  `desktopCapturer` threw *"Failed to get sources"* with the switch in System
  Settings visibly on, and `tccutil` showed three records for the one bundle id.

  Underneath that, two instances ran at once. `verify:mac` launches with its own
  `--user-data-dir`, which does **not** trip the single-instance lock, so a
  leftover verification instance ran beside the real app on a different store —
  one showing the overlay with the user's key, the other showing onboarding
  claiming no key was set. Same app, two windows, contradicting each other.

  Read-only by design: the remedies touch installed apps and system privacy
  records. Wired into `verify:mac`, so `build:mac` fails on a dirty machine.

### Changed

- **Electron 29.4.6 → 43.3.0.** Required, not hygiene: 29 is EOL, is what
  rejected its own valid ASAR hash, and this app renders model output. All 114
  unit, 63 smoke and 29 Playwright tests pass on it unchanged.
- `hardenedRuntime` is now explicitly `false` and pinned by a test. It turns on
  library validation, which needs one Team ID across every loaded binary; an
  ad-hoc signature has none, so switching it on without a certificate produces an
  app that cannot load its own frameworks. It goes back to `true` **with**
  notarisation, not before.
- `npm start` hides the Dock icon on macOS, matching what `LSUIElement` does to
  the packaged build, so development and production are the same product.
- The tray and the global hotkeys are now registered **before** anything reads
  the key. Whatever else fails, the app stays reachable and quittable.

- **The arrow was dropped on two paths, silently.** A one-step plan is turned
  into prose and returned as an answer, but the answer branch only read the
  top-level `target` — which a task-shaped reply does not carry, because its
  target sits inside the step. A model that correctly said "click the Razor
  tool" produced prose telling the user to click it and drew nothing.
  `targetFrom()` now falls back to the first step naming a control, skipping
  steps like "wait for the installer to finish" that legitimately have none.

  Separately, the answer prompt told the model to omit `target` when it could
  not see the control, so an unsure model never reached `locate()` — the second
  pass that exists only to find controls, is better at small ones, and already
  reports `found:false` safely. Asking about something in the Dock is exactly
  that case. The prompt now requires a target whenever the question is itself
  about locating something.

- **The suites leaked a temp directory per test** — 21 from key-ownership, 29
  from Playwright, 3 from the store tests, never removed. Not cosmetic: the
  doctor counts stray `handrail-*` directories precisely because a leftover one
  can be the store a second instance is running against, and suite debris buried
  that signal. 53 leaked directories became 0.

### Known gaps

Still untested on macOS, honestly: **Retina** (the test machine is 1920×1080 at
`scaleFactor: 1`, so the 2x arrow geometry remains unverified), **multi-monitor**,
and **Intel/x64** (built, never run).

**The arrow itself is now verified on macOS**, but by injection rather than by a
live model call: a known box was pushed through `parseBox` → `boxToScreenRect` →
`arrowLayout` → the real arrow window, and the computed centre landed on the
target exactly while the tip sat 14px off the control edge, matching
`ARROW.tipGap`. That proves the coordinate pipeline and the window placement. It
does not prove Retina, and it does not prove the model can resolve a ~40px Dock
icon on a 1x display — which it could not, and which is a model-capability limit,
not a bug that got fixed here.

---

## [0.1.3] — 2026-08-09

The oldest open product complaint, closed: Handrail inventing menu paths for
software that is not on the screen.

### Changed

- **The default model is now `google/gemini-3.5-flash`**, up from
  `google/gemini-3.5-flash-lite`.

  `src/main/prompts.js` has always told the model, in as many words, never to
  guess at a menu or path it cannot actually see. The lite tier ignored that.
  An instruction the model does not follow is a capability problem, not a prompt
  problem, so the model tier was the lever left to pull.

  Measured on a real desktop with `scripts/compare-models.js`, same screenshot,
  same prompt:

  | Question | `flash-lite` | `flash` |
  |---|---|---|
  | "where do I change the theme?" | invented a gear icon at the bottom of WhatsApp's sidebar — there is no gear there | named the three-dot menu at the top of the Chats column, which is real and where it said, and noticed a second app was on screen and asked which was meant |
  | "how do I turn on dark mode in Obsidian?" *(Obsidian not open)* | described the inside of Obsidian's settings window as though it were visible | made step 1 "Open Obsidian from your taskbar", pointing at the taskbar icon, then gave the path |

  The second row is the exact failure recorded in `CONTEXT.md` as the standing
  product gap. It reproduced on the first attempt and the better model did not
  make it.

  Cost, measured rather than assumed: **$0.0006 per question** on the old model,
  **$0.0024** on the new one. Four times more, and still a fifth of a penny.
  Being wrong is far more expensive than that for an audience that cannot tell
  a wrong instruction from a right one.

### Added

- `scripts/compare-models.js` (`npm run compare-models`) — runs one real
  screenshot past several models and prints the answers side by side, so the
  choice of model is checkable rather than an article of faith. Reads the key
  from the app's own store. Costs about a penny a run.

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

Commit `7909792` is the pristine upstream import; `git diff 7909792..HEAD` is
the original work. Upstream and third-party credit is recorded in
[NOTICE](NOTICE).

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

[0.1.3]: https://github.com/M19K/handrail/releases/tag/v0.1.3
[0.1.2]: https://github.com/M19K/handrail/releases/tag/v0.1.2
[0.1.1]: https://github.com/M19K/handrail/releases/tag/v0.1.1
[0.1.0]: https://github.com/M19K/handrail/releases/tag/v0.1.0
