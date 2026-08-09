# Decisions

Append-only. One line per decision: date — what was decided — why.
**Never rewrite an earlier line.** If a decision is reversed, add a new line saying so.

---

- 2026-08-01 — Build the product as a fork of OpenCluely rather than from scratch — ~60% of the plumbing (overlay, capture, streaming, windowing) is reusable; rewriting it would be wasted effort
- 2026-08-01 — Product named **Handrail** — what you grab when navigating unfamiliar terrain; communicates support without implying concealment
- 2026-08-01 — Target audience is **non-technical users** — evening the score for people who can follow instructions but can't diagnose failures
- 2026-08-01 — Drop the interview/DSA use case entirely — it is upstream's purpose, not ours, and frames the product around evasion
- 2026-08-01 — Treat upstream license as **Apache 2.0** — the LICENSE file governs; package.json (ISC) and README badge (MIT) are wrong
- 2026-08-01 — Do not use GitHub's Fork button; use a fresh repo with first commit = pristine upstream import — keeps our work legible as ours while attributing honestly
- 2026-08-01 — Use **OpenRouter** for both LLM and speech-to-text on a single key — no local Python/ffmpeg toolchain needed, and this machine has no CUDA GPU
- 2026-08-01 — Default model `google/gemini-2.5-flash`, STT `openai/whisper-1` — cheapest workable combination (~$0.42/hr of full voice+AI use)
- 2026-08-01 — Adopt **gstack** as the workflow spine — sprint order feeds output forward sequentially
- 2026-08-01 — Disable the **superpowers** plugin — competing planning/TDD/review methodology, would collide with gstack on the same requests
- 2026-08-01 — Keep the **playwright** plugin — its `_electron` API is the only viable QA automation path for an Electron overlay
- 2026-08-01 — Skip `greensock/gsap-skills` for now — an overlay needs motion restraint; CSS plus the animation trio suffices
- 2026-08-01 — Prioritise `apple-design` above its position in the original stack doc — macOS is a first-class target and its motion language suits a floating overlay
- 2026-08-01 — Handrail is a **desktop app only** — no web front end in scope
- 2026-08-01 — Cross-platform Windows **and macOS** is a hard requirement, not a nice-to-have
- 2026-08-01 — Apple Developer Program status confirmed **NOT enrolled** (free tier only; enrolment page shows "Select your entity type") — the remembered D-U-N-S belongs to an incomplete enrolment or another Apple ID
- 2026-08-01 — Ship macOS as an **unsigned .dmg** for v1 with the Gatekeeper workaround documented prominently — $99 is better spent elsewhere right now
- 2026-08-01 — Enrol in the Apple Developer Program **later**, as **Individual / Sole Proprietor** not Organization — faster verification (24-48h vs days/weeks), sufficient for non-App-Store distribution, and puts the author's own name on portfolio work
- 2026-08-01 — Signing is **configuration, not architecture** — adding it later requires one electron-builder config block plus a CI secret, so deferring costs nothing
- 2026-08-01 — **Cut voice/speech entirely from v1** — most complex subsystem, only feature with an unsolved macOS problem (system-audio loopback driver), ~$0.36/hr to run, and the use case is screenshot-driven
- 2026-08-01 — **Discard the entire existing UI** — no coherent workflow, no home/dashboard, structurally incoherent; full rework rather than incremental improvement
- 2026-08-01 — v1 scope is Windows + macOS (unsigned), screenshot and text driven, no voice
- 2026-08-01 — **Flagship use case is operating complex software** (Premiere, After Effects, Unreal, Excel) — "the best way to learn is by doing"; guided live over the real app beats watching a tutorial
- 2026-08-01 — Three UI states: collapsed pill → expanded bar → expanded answer; **expanded bar is the default on launch**
- 2026-08-01 — No separate dashboard app — the overlay expands into sections/side panels for settings, keys, and history
- 2026-08-01 — Screen capture **on by default**, with a toggle to disable — rejected letting the model decide, too unpredictable
- 2026-08-01 — Capture **full screen only**, on **whichever monitor the overlay currently sits on** — no region select, no window picker; move the overlay to change what it sees
- 2026-08-01 — Show a "screenshot captured" indicator but **no thumbnail preview** — redundant when capturing the whole screen
- 2026-08-01 — **Hybrid task model** — quick answers for generic questions, step tracking for genuinely multi-step tasks; requires intent classification
- 2026-08-01 — Checklist UI appears **only** for multi-step tasks — most prompts are generic, so always-on would be noise
- 2026-08-01 — **Visual cues on screen (arrows at real buttons) deferred to v1.1** but architecture must not foreclose it — it is the strongest differentiator
- 2026-08-01 — Threads behave like Claude chats: new thread on restart, auto-titled from first prompt, rename/delete, persist locally, search by name
- 2026-08-01 — All storage **local** (screenshots, keys, threads) — only the AI request leaves the machine; state this plainly in onboarding
- 2026-08-01 — **No local redaction** of sensitive on-screen content in v1
- 2026-08-01 — **Keep invisibility in full** — not the purpose, but useful and already built; Handrail can be used like Cluely/Pluely minus meeting recording
- 2026-08-01 — File attach exists to supply **reference material for the current task** (e.g. app documentation as PDF), working alongside screen capture — not a general file manager
- 2026-08-01 — Single API key field that **auto-detects provider** from key format — no dropdown, no provider selection
- 2026-08-01 — Design: take Cluely's restraint + Pluely's drag grip, thread panel and file attach; reject Pluely's navigational sprawl
- 2026-08-08 — /office-hours run in **Builder mode** (open source / portfolio), not Startup mode — goals are portfolio, personal use, and course, all builder goals
- 2026-08-08 — **The arrow is the demo moment** — the one thing legible in a single screenshot and the only feature neither Cluely nor Pluely has
- 2026-08-08 — **Arrow moves into v1** (reversing the earlier v1.1 deferral) — a portfolio piece whose headline ships later is a weak portfolio piece
- 2026-08-08 — **Spike the arrow first**, half a day, as a go/no-go gate — vision-model coordinate accuracy is the only genuine unknown; checklist-as-headline is the fallback
- 2026-08-08 — **Approach C: Spike-Led Rebuild** chosen over Strip-and-Reskin (A) and straight Renderer Rewrite (B) — same destination as B with the risk sequenced first
- 2026-08-08 — Keep the **main process**, delete **all four renderer windows**, rebuild as one overlay + panels; IPC contract redesigned alongside
- 2026-08-08 — **Honest framing on the install gap** — unsigned macOS requires a Gatekeeper bypass a non-technical user won't do; README states the real v1 audience and ships a first-class install guide rather than overclaiming
- 2026-08-08 — Design doc: `~/.gstack/projects/TechyCSR-OpenCluely/m19k1-main-design-20260808-205158.md`
- 2026-08-08 — Note: gstack project slug is `TechyCSR-OpenCluely` (from git remote) — changes when the repo is re-inited as Handrail; early artifacts live under the old slug
