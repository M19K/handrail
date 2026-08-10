<div align="center">

<img src="design/brand/mark.svg" width="72" alt="">

# Handrail

**A desktop overlay that sees your screen and walks you through complex software, step by step.**

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

Grab an installer from [Releases](../../releases).

**Windows** — run the `.exe`. It is unsigned, so SmartScreen warns on first
run: **More info** → **Run anyway**.

**macOS** — open the `.dmg` and drag Handrail to Applications. It is not
notarised, so the first launch is refused with *"Apple could not verify
"Handrail" is free of malware"*. Getting past it takes two steps:

1. Double-click Handrail, then click **Done** on the warning.
2. **System Settings → Privacy & Security**, scroll to Security, and click
   **Open Anyway** next to *"Handrail" was blocked*. Confirm with **Open Anyway**.

After that it opens normally, forever. You only do this once.

Handrail has **no Dock icon** — it lives in the menu bar. Look for the rail mark
at the top right of your screen, or press **⌘⇧H**.

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
npm run dev:renderer   # drive the UI through every state, screenshot each
npx electron scripts/smoke.js   # boot the real windows and check them
```

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
