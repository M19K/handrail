<div align="center">

<img src="design/brand/mark.svg" width="72" alt="">

# Handrail

**A desktop overlay that sees your screen and walks you through complex software, step by step.**

<br>

<img src="docs/screenshots/pointing.png" width="900" alt="Handrail answering &quot;where do I change my screen resolution?&quot; over Windows Settings, with a mint arrow drawn on the actual Display resolution dropdown">

<sub>A real question, a real screen, a real arrow. Not a mockup — this is the shipped build.</sub>

</div>

---

Most software help assumes you already know what things are called. You search,
find a tutorial, watch someone do it on *their* screen, then try to map it onto
yours. Handrail skips that. It sits on top of the app you are actually using,
looks at what is in front of you, and tells you what to do next — pointing at
the real button, on your real screen.

**It is built for people who are not technical.** Someone who can follow an
instruction precisely but cannot diagnose why step 4 failed.

## What it does

- **Sees your screen.** Every question includes a screenshot, so answers are
  about your situation rather than about the software in general.
- **Points at things.** An arrow appears on screen, at the actual control you
  need. Not "the button in the top right" — *that* button.

  **Pointing needs a model that will name what it is pointing at.** The default,
  `google/gemini-3.5-flash`, does this reliably and is what the arrow is tested
  against. Some other models answer well but never name a target, so the answer
  arrives and no arrow is drawn — Claude Sonnet behaves this way today. If the
  arrow stops appearing, check which model is selected in Settings before
  assuming anything is broken.
- **Keeps up with you.** For multi-step tasks it watches for each step being
  done and moves on by itself. You are not expected to tick anything off.
- **Tells you when you have gone wrong.** The most useful thing it does, and
  the reason it exists.

Built for operating complex software — Premiere Pro, After Effects, Unreal
Engine, Excel — and equally happy explaining an error dialog or getting a
terminal command right.

## Privacy

Screenshots, your API key and every conversation stay on your machine. The only
thing that leaves your computer is the request you send to your AI provider.
There is no telemetry, no account and no sign-up.

The API key is encrypted at rest using your operating system's keychain. It
never crosses into the app's UI layer after setup — only a masked hint does.

## Install

Grab an installer from [Releases](../../releases). Every release carries both
platforms — two `.dmg` files for macOS (`-arm64` for Apple Silicon, the other
for Intel) and the Windows `.exe`. If a release is ever missing your platform,
that is a mistake in the release, not a decision.

**Windows** — there are two. `Handrail-Setup-x.y.z.exe` installs it properly
with a Start-menu and desktop shortcut. `Handrail.x.y.z.exe` is portable — it
runs from wherever you put it and installs nothing.

Handrail is unsigned, so SmartScreen warns on first run: **More info** →
**Run anyway**.

If you have **Smart App Control** turned on (Windows 11 only), it can refuse to
start Handrail outright — and unlike SmartScreen there is no "Run anyway" to
click. It blocked the installer on the machine this was tested on while letting
the portable build run, so **if one is refused, try the other** — but neither is
guaranteed. To check whether it is on: Windows Security → **App & browser
control** → **Smart App Control**.

Turning it off is a one-way change: Windows will not let you switch it back on
without reinstalling. The only proper fix is code signing, which is a paid
certificate this project does not have.

Handrail stays out of the taskbar and lives in the **system tray** instead.
Windows hides new tray icons in the overflow flyout, so click the **^** arrow
near the clock and drag the Handrail mark out to keep it visible.

**macOS** — open the `.dmg` and drag Handrail to Applications. It is not
notarised, so the first launch is refused with *"Apple could not verify
"Handrail" is free of malware"*. Getting past it takes two steps:

1. Double-click Handrail, then click **Done** on the warning.
2. **System Settings → Privacy & Security**, scroll to Security, and click
   **Open Anyway** next to *"Handrail" was blocked*. Confirm with **Open Anyway**.

After that it opens normally, forever. You only do this once.

Handrail has **no Dock icon** — it lives in the menu bar. Look for the rail mark
at the top right of your screen, or press **⌘⇧H**.

### Keyboard shortcuts

| | macOS | Windows |
|---|---|---|
| Show or hide Handrail | **⌘⇧H** | **Ctrl+Shift+H** |
| Hide it immediately | **⌘⇧⎋** | **Ctrl+Alt+H** |

The second one is the panic key, for when the overlay is on screen and you are
sharing it. It puts Handrail away and clears any arrow it had drawn.

On Windows it is **not** Ctrl+Shift+Esc — Windows reserves that for Task
Manager and will not hand it to any application.

You will need an API key from [OpenRouter](https://openrouter.ai/keys), OpenAI
or Anthropic. Onboarding asks for one and works out which is which from the key
itself.

### Or build it

```bash
git clone https://github.com/M19K/handrail && cd handrail
npm install
npm start
```

To produce a Windows build locally, without electron-builder:

```bash
npx electron scripts/make-icons.js
node scripts/package-win.js --install
```

That exists because electron-builder cannot run on every Windows machine —
extracting its signing toolchain creates symlinks, which Windows refuses without
Developer Mode. Releases are built in CI, where that is not a problem.

### A word about macOS

Handrail is signed **ad-hoc**, not with an Apple Developer ID, and it is not
notarised. macOS refuses the first launch; the two steps above clear it for good.

The distinction matters more than it sounds. Through v0.1.3 the build was not
signed at all — what shipped was the linker's stub, with none of the bundle's
resources sealed. Gatekeeper does not call that "unverified", it calls it
**"damaged and can't be opened"**, and offers only *Move to Trash*. There is no
Open, right-click → Open shows the same dialog, and no "Open Anyway" row ever
appears in Privacy & Security, because that row is only offered for the
unverified-developer verdict. The only way in was a Terminal command. On a
product aimed at people who cannot diagnose a failing install, that made the
macOS build unusable rather than inconvenient.

A valid ad-hoc signature costs nothing and no Apple account, and it is what
moves the app from *impossible* to *two documented clicks*. It is not the
destination: **Developer ID + notarisation is the only way to get a clean
double-click**, and until that exists the realistic macOS audience is people
willing to do those two clicks once. See [PLATFORM.md](PLATFORM.md).

## How it works

```
you type a question
  ↓
screenshot of the display the overlay is on   src/main/capture.js
  ↓
one model call decides: answer, or plan       src/main/llm.js
  ↓
answer → done
plan   → checklist + an arrow at step 1       src/main/turn.js
  ↓
watch the screen, advance when a step is done
```

The watching loop is the interesting part, because naively it would be
expensive. It is gated: a free local frame comparison, then a quiet period so
it never reads a half-finished action, then one small request against a
criterion the model wrote when it made the plan. A user reading their screen
and not touching anything costs nothing at all.

Coordinates come back normalised 0–1000 rather than in pixels, which makes DPI
scaling and multi-monitor setups a non-issue by construction — see
[`src/main/geometry.js`](src/main/geometry.js).

## Development

```bash
npm start              # run the app
npm test               # unit tests, no Electron needed
npm run qa             # Playwright, against the real Electron app
npm run dev:renderer   # drive the UI through every state, screenshot each
npx electron scripts/smoke.js   # boot the real windows and check them
npm run verify:mac     # launch the PACKAGED .app — the only check that does
npm run doctor         # the macOS environment around the app, not the app
```

The suites are layered on purpose, because each is blind to the one below it.
The unit tests never launch Electron, `smoke.js` never opens the packaged
bundle, `verify:mac` never asks whether a reply was any good, and none of them
can see the machine. `src/main/llm.scenarios.test.js` is the newest layer and
the least obvious: it puts real user questions through the real reply path and
asserts what a person would notice — that a reply is never empty, never raw
JSON, and never ends on a colon promising a list it does not deliver.

`npm run dev:renderer` runs the overlay against a mock IPC bridge, so the whole
interface can be worked on without a running main process or an API key.

Set `STEALTH_MODE=false` to make the overlay visible to screen recording, which
you will want when screenshotting the UI.

### Layout

```
main.js               entry point
preload.js            the entire main↔renderer bridge  (see docs/IPC.md)
src/main/             store · llm · capture · turn · windows · ipc
renderer/             overlay · arrow · onboarding
design/               tokens, brand assets, and the design work behind them
spike/arrow/          the go/no-go spike for on-screen pointing
docs/IPC.md           the IPC contract
```

Project documents: [PRODUCT.md](PRODUCT.md) for what Handrail is and how it
behaves, [DECISIONS.md](DECISIONS.md) for every decision and why,
[CONTEXT.md](CONTEXT.md) for current state, [PLATFORM.md](PLATFORM.md) for
Windows/macOS parity.

## Authorship, credit and licence

**Handrail is an original product designed and built by Maaz Kazi.**
Copyright © 2026 Maaz Kazi. Every original source file carries a copyright
header, and [NOTICE](NOTICE) lists what is original and what is not.

The product concept, the guided-task model, the on-screen pointing system, the
step-watching loop, the prompt layer, the whole main process, the whole
renderer, the IPC contract, the brand and design system, the build and release
tooling, and all documentation are original work.

Commit `7909792` is the pristine upstream import and nothing else, so
`git diff 7909792..HEAD` is exactly and only the original work.

Licensed under [Apache 2.0](LICENSE). Third-party and upstream credit is
recorded in [NOTICE](NOTICE).
